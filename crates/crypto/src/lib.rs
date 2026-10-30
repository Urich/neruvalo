use anyhow::{anyhow, bail, ensure, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use crypto_box::aead::{rand_core::RngCore, OsRng};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use hkdf::Hkdf;
use opaque_ke::CipherSuite;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256, Sha512};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

pub struct Suite;
impl CipherSuite for Suite {
    type OprfCs = opaque_ke::Ristretto255;
    type KeyExchange = opaque_ke::TripleDh<opaque_ke::Ristretto255, Sha512>;
    type Ksf = Argon2<'static>;
}
pub fn kdf() -> Argon2<'static> {
    Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(65536, 3, 1, None).expect("fixed valid KDF"),
    )
}
pub fn b64(data: impl AsRef<[u8]>) -> String {
    URL_SAFE_NO_PAD.encode(data)
}
pub fn unb64(data: &str) -> Result<Vec<u8>> {
    Ok(URL_SAFE_NO_PAD.decode(data)?)
}
pub fn random<const N: usize>() -> [u8; N] {
    let mut out = [0; N];
    OsRng.fill_bytes(&mut out);
    out
}
pub fn token() -> String {
    b64(random::<32>())
}
pub fn digest(value: &str) -> String {
    b64(Sha256::digest(value.as_bytes()))
}
pub fn derive(secret: &[u8], context: &[u8]) -> Result<Zeroizing<[u8; 32]>> {
    let mut out = Zeroizing::new([0; 32]);
    Hkdf::<Sha256>::new(Some(b"neruvalo-v1"), secret)
        .expand(context, out.as_mut())
        .map_err(|_| anyhow!("KDF failure"))?;
    Ok(out)
}
pub fn password_key(password: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>> {
    ensure!(salt.len() == 16, "invalid salt");
    let mut out = Zeroizing::new([0; 32]);
    kdf()
        .hash_password_into(password.as_bytes(), salt, out.as_mut())
        .map_err(|_| anyhow!("KDF failure"))?;
    Ok(out)
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Envelope {
    pub format_version: u32,
    pub suite: String,
    pub nonce: String,
    pub ciphertext: String,
}
pub fn seal(key: &[u8], clear: &[u8], context: &[u8]) -> Result<Envelope> {
    let nonce = random::<24>();
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| anyhow!("invalid key"))?;
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: clear,
                aad: context,
            },
        )
        .map_err(|_| anyhow!("encryption failure"))?;
    Ok(Envelope {
        format_version: 1,
        suite: "xchacha20poly1305-v1".into(),
        nonce: b64(nonce),
        ciphertext: b64(ciphertext),
    })
}
pub fn open(key: &[u8], envelope: &Envelope, context: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    ensure!(
        envelope.format_version == 1 && envelope.suite == "xchacha20poly1305-v1",
        "unsupported envelope"
    );
    let nonce = unb64(&envelope.nonce)?;
    ensure!(nonce.len() == 24, "invalid nonce");
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| anyhow!("invalid key"))?;
    Ok(Zeroizing::new(
        cipher
            .decrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &unb64(&envelope.ciphertext)?,
                    aad: context,
                },
            )
            .map_err(|_| anyhow!("incorrect secret or damaged data"))?,
    ))
}
#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct AccountKeys {
    pub owner: [u8; 32],
    pub sign: [u8; 32],
    pub share: [u8; 32],
}
impl AccountKeys {
    pub fn generate() -> Self {
        Self {
            owner: random(),
            sign: random(),
            share: random(),
        }
    }
    pub fn public_sign(&self) -> String {
        b64(SigningKey::from_bytes(&self.sign)
            .verifying_key()
            .as_bytes())
    }
    pub fn public_share(&self) -> String {
        b64(crypto_box::SecretKey::from(self.share)
            .public_key()
            .as_bytes())
    }
    pub fn sign(&self, data: &[u8]) -> String {
        b64(SigningKey::from_bytes(&self.sign).sign(data).to_bytes())
    }
}
pub fn verify(public: &str, data: &[u8], signature: &str) -> Result<()> {
    let pk: [u8; 32] = unb64(public)?
        .try_into()
        .map_err(|_| anyhow!("invalid public key"))?;
    let sig = Signature::from_slice(&unb64(signature)?)?;
    VerifyingKey::from_bytes(&pk)?.verify_strict(data, &sig)?;
    Ok(())
}
pub fn sign_seed(seed: &[u8; 32], data: &[u8]) -> String {
    b64(SigningKey::from_bytes(seed).sign(data).to_bytes())
}
pub fn public_seed(seed: &[u8; 32]) -> String {
    b64(SigningKey::from_bytes(seed).verifying_key().as_bytes())
}
pub fn account_context(server: &str, account: &str, purpose: &str) -> Vec<u8> {
    serde_json::to_vec(&("neruvalo-v1", server, account, purpose)).expect("tuple")
}
#[derive(Clone, Serialize, Deserialize)]
pub struct EncryptedVersion {
    pub data: Envelope,
    pub owner_key: Envelope,
}
pub fn encrypt_version(
    keys: &AccountKeys,
    data: &[u8],
    context: &[u8],
) -> Result<EncryptedVersion> {
    let key = Zeroizing::new(random::<32>());
    Ok(EncryptedVersion {
        data: seal(key.as_ref(), data, context)?,
        owner_key: seal(&keys.owner, key.as_ref(), context)?,
    })
}
pub fn decrypt_version(
    keys: &AccountKeys,
    v: &EncryptedVersion,
    context: &[u8],
) -> Result<Zeroizing<Vec<u8>>> {
    let key = open(&keys.owner, &v.owner_key, context)?;
    open(&key, &v.data, context)
}
pub fn parse_key(bytes: &[u8]) -> Result<Zeroizing<[u8; 32]>> {
    if bytes.len() != 32 {
        bail!("invalid root key")
    };
    let mut out = Zeroizing::new([0; 32]);
    out.copy_from_slice(bytes);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encryption_binds_context_and_detects_tampering() {
        let k = random::<32>();
        let mut e = seal(&k, b"private", b"account A").unwrap();
        assert_eq!(&*open(&k, &e, b"account A").unwrap(), b"private");
        assert!(open(&k, &e, b"account B").is_err());
        let mut c = unb64(&e.ciphertext).unwrap();
        c[0] ^= 1;
        e.ciphertext = b64(c);
        assert!(open(&k, &e, b"account A").is_err());
    }
    #[test]
    fn signatures_bind_message() {
        let k = AccountKeys::generate();
        let s = k.sign(b"one");
        verify(&k.public_sign(), b"one", &s).unwrap();
        assert!(verify(&k.public_sign(), b"two", &s).is_err());
    }
    #[test]
    fn rfc_hkdf_domains_differ() {
        let k = random::<32>();
        assert_ne!(
            *derive(&k, b"auth").unwrap(),
            *derive(&k, b"recovery").unwrap()
        );
    }
}

pub fn seal_shared_key(public: &str, key: &[u8]) -> Result<String> {
    let bytes: [u8; 32] = unb64(public)?
        .try_into()
        .map_err(|_| anyhow!("invalid recipient key"))?;
    Ok(b64(crypto_box::PublicKey::from(bytes)
        .seal(&mut OsRng, key)
        .map_err(|_| anyhow!("sealed box failure"))?))
}
pub fn open_shared_key(keys: &AccountKeys, ciphertext: &str) -> Result<Zeroizing<Vec<u8>>> {
    Ok(Zeroizing::new(
        crypto_box::SecretKey::from(keys.share)
            .unseal(&unb64(ciphertext)?)
            .map_err(|_| anyhow!("sealed box failure"))?,
    ))
}

#[cfg(test)]
mod shared_tests {
    use super::*;
    #[test]
    fn sealed_keys_are_recipient_specific_and_aead_context_is_required() {
        let alice = AccountKeys::generate();
        let bob = AccountKeys::generate();
        let key = random::<32>();
        let wrapped = seal_shared_key(&alice.public_share(), &key).unwrap();
        assert_eq!(
            open_shared_key(&alice, &wrapped).unwrap().as_slice(),
            key.as_slice()
        );
        assert!(open_shared_key(&bob, &wrapped).is_err());
        let e = seal(
            &key,
            b"copy",
            b"server/owner/recipient/record/share/copy/version",
        )
        .unwrap();
        assert!(open(&key, &e, b"other recipient").is_err());
    }
}

#[cfg(test)]
mod shared_signature_vector {
    use super::*;
    #[test]
    fn fixed_ed25519_shared_copy_signature_verifies() {
        let vector: serde_json::Value = serde_json::from_str(include_str!(
            "../../../docs/test-vectors/shared-copy-v2.json"
        ))
        .unwrap();
        verify(
            vector["copy"]["owner_sign"].as_str().unwrap(),
            vector["transcript_utf8"].as_str().unwrap().as_bytes(),
            vector["copy"]["signature"].as_str().unwrap(),
        )
        .unwrap();
    }
}
