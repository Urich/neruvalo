use clap::Parser;
use neruvalo_server::config::{ServerConfig, DEFAULT_CONFIG};
use std::path::PathBuf;

#[derive(Parser)]
#[command(version, about = "Neruvalo development server")]
struct Args {
    /// TOML config file. Defaults to neruvalo-server.toml in the working directory.
    #[arg(long, value_name = "FILE")]
    config: Option<PathBuf>,
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    tracing_subscriber::fmt()
        .with_env_filter("neruvalo_server=info")
        .init();
    let default_path = PathBuf::from(DEFAULT_CONFIG);
    let config = match args.config {
        Some(path) => ServerConfig::load(&path)?,
        None => match default_path.try_exists()? {
            true => ServerConfig::load(&default_path)?,
            false => {
                tracing::info!("No server config found; using legacy environment settings");
                ServerConfig::from_env()?
            }
        },
    };
    let socket = config.listen;
    let app = neruvalo_server::application_with_config(&config).await?;
    let listener = tokio::net::TcpListener::bind(socket).await?;
    tracing::info!(%socket,"Neruvalo development server ready; email codes are written to the private dev outbox");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
