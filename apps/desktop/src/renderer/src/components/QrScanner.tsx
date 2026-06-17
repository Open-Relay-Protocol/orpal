import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

/** Webcam QR scanner. Calls onResult with the decoded text once a QR is found. */
export function QrScanner({ onResult }: { onResult: (text: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let cancelled = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const scan = () => {
      const video = videoRef.current;
      if (!cancelled && video && ctx && video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const found = jsQR(img.data, img.width, img.height);
        if (found?.data) {
          onResult(found.data);
          return; // stop scanning
        }
      }
      if (!cancelled) raf = requestAnimationFrame(scan);
    };

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (cancelled) return;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          raf = requestAnimationFrame(scan);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Camera unavailable");
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onResult]);

  if (error) return <div className="muted scan-error">Camera error: {error}. Use paste instead.</div>;
  return <video ref={videoRef} className="scanner" muted playsInline />;
}
