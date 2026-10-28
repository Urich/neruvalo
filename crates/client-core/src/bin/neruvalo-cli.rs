use anyhow::{anyhow, Result};
use clap::{Parser, Subcommand};
use neruvalo_client::{Client, RecordData};
use std::{
    collections::BTreeMap,
    io::{self, Write},
    path::PathBuf,
};
use zeroize::Zeroizing;
#[derive(Parser)]
#[command(about = "Neruvalo native prototype client. Test data only.")]
struct Args {
    #[arg(long, default_value = "local-data/client")]
    data_dir: PathBuf,
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    Register {
        #[arg(long, default_value = "http://127.0.0.1:8787")]
        server: String,
        login: String,
        email: String,
        #[arg(long)]
        certificate: Option<PathBuf>,
    },
    Login {
        #[arg(long, default_value = "http://127.0.0.1:8787")]
        server: String,
        login: String,
    },
    Offline {
        profile: String,
    },
    Profiles,
    Recover {
        certificate: PathBuf,
    },
}
fn input(prompt: &str) -> Result<String> {
    print!("{prompt}");
    io::stdout().flush()?;
    let mut s = String::new();
    io::stdin().read_line(&mut s)?;
    Ok(s.trim_end().to_owned())
}
fn password(prompt: &str) -> Result<Zeroizing<String>> {
    Ok(Zeroizing::new(rpassword::prompt_password(prompt)?))
}
#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let mut c = Client::new(args.data_dir)?;
    match args.command {
        Command::Register {
            server,
            login,
            email,
            certificate,
        } => {
            let p = password("Master password (at least 12 characters): ")?;
            let confirm = password("Confirm master password: ")?;
            anyhow::ensure!(*p == *confirm, "Passwords differ");
            let r = c
                .register_begin(&server, &login, &email, p, certificate.is_some())
                .await?;
            println!(
                "Development confirmation email: {}.txt in the server outbox",
                r["ticket"].as_str().unwrap_or_default()
            );
            c.register_finish(&server, &input("Email confirmation code: ")?)
                .await?;
            if let Some(path) = certificate {
                c.save_certificate_to(&path)?;
                println!("Recovery certificate saved. Keep it private.");
            }
            println!("Account registered. Run login to open the vault.");
        }
        Command::Profiles => println!("{}", serde_json::to_string_pretty(&c.profiles().await?)?),
        Command::Recover { certificate } => {
            let certificate = Zeroizing::new(std::fs::read_to_string(certificate)?);
            let p = password("New master password: ")?;
            c.recover(certificate, p).await?;
            println!("Password replaced and server sessions revoked. Log in again.");
        }
        Command::Login { server, login } => {
            c.login(&server, &login, password("Master password: ")?)
                .await?;
            shell(&mut c).await?;
        }
        Command::Offline { profile } => {
            c.unlock_offline(&profile, password("Master password: ")?)
                .await?;
            shell(&mut c).await?;
        }
    }
    Ok(())
}
async fn shell(c: &mut Client) -> Result<()> {
    println!("Commands: list, new, show ID, history ID, archive ID, restore ID, sync, timeout SECONDS, quit.");
    loop {
        let line = input("neruvalo> ")?;
        let mut words = line.split_whitespace();
        let command = words.next().unwrap_or("");
        let id = words.next().unwrap_or("");
        let result: Result<()> = async {
            match command {
                "quit" | "lock" => {
                    c.lock();
                    return Ok(());
                }
                "list" => {
                    for r in c.list().await? {
                        println!(
                            "{}  v{}  {}{}",
                            r.record_id,
                            r.revision,
                            if r.archived { "[archived] " } else { "" },
                            r.data.title
                        );
                    }
                }
                "new" => {
                    let title = input("Title: ")?;
                    let login = input("Login: ")?;
                    let secret = password("Secret: ")?;
                    let d = RecordData {
                        record_type: "login".into(),
                        schema_version: 1,
                        title,
                        fields: BTreeMap::from([
                            ("login".into(), login),
                            ("password".into(), secret.to_string()),
                        ]),
                        notes: String::new(),
                        folder: String::new(),
                        tags: vec![],
                        extra: BTreeMap::new(),
                    };
                    c.save(None, 0, d, false).await?;
                    println!("Encrypted record saved.");
                }
                "show" => {
                    let versions = c.history(id).await?;
                    let r = versions.first().ok_or_else(|| anyhow!("Not found"))?;
                    println!("{}", serde_json::to_string_pretty(&r.data)?);
                }
                "history" => {
                    for r in c.history(id).await? {
                        println!("v{} {} {}", r.revision, r.version_id, r.data.title);
                    }
                }
                "archive" | "restore" => {
                    let mut list = c.history(id).await?;
                    let r = list.remove(0);
                    c.save(Some(id.into()), r.revision, r.data, command == "archive")
                        .await?;
                }
                "sync" => {
                    c.sync().await?;
                    println!("Synchronized.");
                }
                "timeout" => {
                    c.settings(id.parse()?).await?;
                }
                "" => {}
                _ => println!("Unknown command"),
            }
            Ok(())
        }
        .await;
        if let Err(e) = result {
            eprintln!("{e}");
        }
        if command == "quit" || command == "lock" {
            break;
        }
    }
    Ok(())
}
