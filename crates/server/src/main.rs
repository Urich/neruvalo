#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("neruvalo_server=info")
        .init();
    anyhow::ensure!(std::env::var("NERUVALO_DEV_MODE").as_deref()==Ok("true"),
        "This prototype requires NERUVALO_DEV_MODE=true and accepts loopback connections only. See docs/prototype.ru.md.");
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "sqlite://neruvalo-server.sqlite3?mode=rwc".into());
    let address = std::env::var("NERUVALO_LISTEN").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let socket: std::net::SocketAddr = address.parse()?;
    anyhow::ensure!(
        socket.ip().is_loopback(),
        "Prototype must listen on loopback"
    );
    let outbox =
        std::env::var("NERUVALO_DEV_OUTBOX").unwrap_or_else(|_| "local-data/dev-outbox".into());
    let app = neruvalo_server::application(&url, outbox.into()).await?;
    let listener = tokio::net::TcpListener::bind(socket).await?;
    tracing::info!(%socket,"Neruvalo development server ready; email codes are written to the private dev outbox");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
