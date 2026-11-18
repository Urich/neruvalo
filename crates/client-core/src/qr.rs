use anyhow::{anyhow, ensure, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use image::GrayImage;
use neruvalo_protocol::ShareContact;
use std::io::Cursor;
use zeroize::Zeroizing;

const QR_IMAGE_SIZE: u32 = 256;
const MAX_CAMERA_FRAME_SIDE: u32 = 512;
const MAX_CAMERA_FRAME_DATA_URL_BYTES: usize = 256 * 1024;
const CAMERA_FRAME_PREFIX: &str = "data:image/jpeg;base64,";

pub(super) fn render(data: &[u8]) -> Result<String, qrcode::types::QrError> {
    let svg = qrcode::QrCode::new(data)?
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(QR_IMAGE_SIZE, QR_IMAGE_SIZE)
        .build();
    Ok(format!(
        "data:image/svg+xml;base64,{}",
        STANDARD.encode(svg.as_bytes())
    ))
}

pub(super) fn decode(image: GrayImage) -> Vec<Zeroizing<String>> {
    let mut prepared = rqrr::PreparedImage::prepare(image);
    prepared
        .detect_grids()
        .into_iter()
        .filter_map(|grid| grid.decode().ok().map(|(_, text)| Zeroizing::new(text)))
        .collect()
}

pub fn scan_share_contact(frame: &str) -> Result<Option<String>> {
    ensure!(
        frame.len() <= MAX_CAMERA_FRAME_DATA_URL_BYTES,
        "CONTACT_CAMERA_ERROR"
    );
    let encoded = frame
        .strip_prefix(CAMERA_FRAME_PREFIX)
        .ok_or_else(|| anyhow!("CONTACT_CAMERA_ERROR"))?;
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| anyhow!("CONTACT_CAMERA_ERROR"))?;
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), image::ImageFormat::Jpeg);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_CAMERA_FRAME_SIDE);
    limits.max_image_height = Some(MAX_CAMERA_FRAME_SIDE);
    reader.limits(limits);
    let codes = decode(
        reader
            .decode()
            .map_err(|_| anyhow!("CONTACT_CAMERA_ERROR"))?
            .into_luma8(),
    );
    match codes.as_slice() {
        [] => Ok(None),
        [code] if ShareContact::decode(code).is_some() => Ok(Some(code.to_string())),
        _ => Err(anyhow!("INVALID_SHARE_CONTACT")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageFormat, Luma};

    fn camera_frame(code: &str) -> String {
        const QUIET_ZONE: u32 = 4;
        const MODULE_SIZE: u32 = 6;
        let qr = qrcode::QrCode::new(code).unwrap();
        let width = qr.width() as u32;
        let side = (width + 2 * QUIET_ZONE) * MODULE_SIZE;
        let image = GrayImage::from_fn(side, side, |x, y| {
            let cell = |pixel: u32| (pixel / MODULE_SIZE).checked_sub(QUIET_ZONE);
            let dark = cell(x).zip(cell(y)).is_some_and(|(x, y)| {
                x < width && y < width && qr[(x as usize, y as usize)] == qrcode::Color::Dark
            });
            Luma([if dark { 0 } else { 255 }])
        });
        let mut jpeg = Cursor::new(Vec::new());
        DynamicImage::ImageLuma8(image)
            .write_to(&mut jpeg, ImageFormat::Jpeg)
            .unwrap();
        format!(
            "{CAMERA_FRAME_PREFIX}{}",
            STANDARD.encode(jpeg.into_inner())
        )
    }

    #[test]
    fn scans_a_contact_from_a_camera_frame_and_rejects_unrelated_codes() {
        let contact = ShareContact {
            server_id: "server".into(),
            account_id: "account".into(),
            login: "alice".into(),
            fingerprint: "fingerprint".into(),
        }
        .encode()
        .unwrap();
        assert_eq!(
            scan_share_contact(&camera_frame(&contact)).unwrap(),
            Some(contact)
        );
        assert_eq!(
            scan_share_contact(&camera_frame("https://example.test/"))
                .unwrap_err()
                .to_string(),
            "INVALID_SHARE_CONTACT"
        );
    }
}
