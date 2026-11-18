import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "./i18n";
import { errorText } from "./model";

const FRAME_MAX_SIDE = 480;
const SCAN_INTERVAL_MS = 250;

export function ContactScanner({
  onScan,
  onClose,
}: {
  onScan: (code: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const preview = useRef<HTMLVideoElement>(null);
  const callbacks = useRef({ onScan, onClose });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { callbacks.current = { onScan, onClose }; }, [onScan, onClose]);
  useEffect(() => {
    const video = preview.current!;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    let active = true;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function stop() {
      active = false;
      clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
    }
    function closeWhenHidden() {
      if (document.hidden) {
        stop();
        callbacks.current.onClose();
      }
    }
    function fail(message: string) {
      stop();
      setError(message);
    }
    async function scan() {
      try {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth && video.videoHeight) {
          const scale = Math.min(1, FRAME_MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          context!.drawImage(video, 0, 0, canvas.width, canvas.height);
          const frame = canvas.toDataURL("image/jpeg");
          const code = await invoke<string | null>("scan_share_contact", { frame });
          if (!active) return;
          if (code) {
            stop();
            callbacks.current.onScan(code);
            return;
          }
        }
        timer = setTimeout(scan, SCAN_INTERVAL_MS);
      } catch (error) {
        if (active) fail(errorText(error));
      }
    }
    async function open() {
      if (!context || !navigator.mediaDevices?.getUserMedia) {
        fail("ui.contactCameraError");
        return;
      }
      try {
        const camera = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" } },
        });
        if (!active) {
          camera.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = camera;
        video.srcObject = stream;
        await video.play();
        if (!active) return;
        setReady(true);
        void scan();
      } catch {
        if (active) fail("ui.contactCameraError");
      }
    }
    document.addEventListener("visibilitychange", closeWhenHidden);
    void open();
    return () => {
      document.removeEventListener("visibilitychange", closeWhenHidden);
      stop();
    };
  }, []);

  return (
    <div className="contact-scanner">
      <video ref={preview} muted playsInline hidden={!ready || !!error} aria-label={t("ui.contactCameraPreview")} />
      {error ? <p role="alert">{t(error)}</p> : <p role="status">{t(ready ? "ui.contactCameraAim" : "ui.contactCameraOpening")}</p>}
      <button type="button" className="secondary" onClick={onClose}>{t("ui.close")}</button>
    </div>
  );
}
