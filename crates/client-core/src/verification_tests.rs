use super::*;
use axum::{http::StatusCode, routing::get, Json, Router};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};

struct View {
    cancelled: bool,
    dropped: Arc<AtomicBool>,
}
impl VerificationView for View {
    fn is_closed(&self) -> bool {
        self.cancelled
    }
}
impl Drop for View {
    fn drop(&mut self) {
        self.dropped.store(true, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn embedded_view_success_cancellation_and_failure() {
    for scenario in ["success", "cancel", "poll_failure"] {
        let dropped = Arc::new(AtomicBool::new(false));
        let calls = Arc::new(AtomicUsize::new(0));
        let secret = "a".repeat(43);
        let app = Router::new()
            .route(
                "/operation",
                get({
                    let dropped = dropped.clone();
                    let calls = calls.clone();
                    let secret = secret.clone();
                    move |headers: axum::http::HeaderMap| {
                        let dropped = dropped.clone();
                        let calls = calls.clone();
                        let secret = secret.clone();
                        async move {
                            calls.fetch_add(1, Ordering::SeqCst);
                            if let Some(proof) = headers.get("x-neruvalo-verification") {
                                assert_eq!(proof, secret.as_str());
                                assert!(dropped.load(Ordering::SeqCst));
                                (StatusCode::OK, Json(json!({"ok":true})))
                            } else {
                                (
                                    StatusCode::PRECONDITION_REQUIRED,
                                    Json(json!({"error":{"code":"VERIFICATION_REQUIRED"},
                                        "verification_secret":secret})),
                                )
                            }
                        }
                    }
                }),
            )
            .route(
                "/api/v1/verification",
                get(move || async move {
                    if scenario == "poll_failure" {
                        (StatusCode::SERVICE_UNAVAILABLE, Json(json!({})))
                    } else {
                        (StatusCode::OK, Json(json!({"verified":true})))
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let expected_url = format!("{origin}/verification#{secret}");
        let opener: VerificationOpener = Box::new({
            let dropped = dropped.clone();
            move |url| {
                assert_eq!(url, expected_url);
                Ok(Box::new(View {
                    cancelled: scenario == "cancel",
                    dropped: dropped.clone(),
                }))
            }
        });
        let http = reqwest::Client::new();
        let result = verified_send(
            http.get(format!("{origin}/operation")),
            &http,
            Some(&opener),
        )
        .await;
        assert!(dropped.load(Ordering::SeqCst));
        match scenario {
            "success" => {
                assert_eq!(result.unwrap().status(), StatusCode::OK);
                assert_eq!(calls.load(Ordering::SeqCst), 2);
            }
            "cancel" => {
                assert_eq!(result.unwrap_err().to_string(), "VERIFICATION_CANCELLED");
                assert_eq!(calls.load(Ordering::SeqCst), 1);
            }
            _ => {
                assert!(result.is_err());
                assert_eq!(calls.load(Ordering::SeqCst), 1);
            }
        }
        server.abort();
    }
}
