import { useCallback, useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

/** Webcam QR scanner. Calls onResult with the decoded text once a QR is found.
 *  Defaults to the rear ("environment") camera on phones, and — when the device
 *  exposes more than one camera — lets the user cycle through them in case the
 *  wrong lens was picked first. */
export function QrScanner({ onResult }: { onResult: (text: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // Keep the latest onResult without re-acquiring the camera when it changes.
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  const [error, setError] = useState<string | null>(null);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  // The explicitly chosen camera. undefined → let the browser pick (rear preferred).
  const [deviceId, setDeviceId] = useState<string | undefined>(undefined);
  // The camera the browser actually resolved to while deviceId is undefined; the
  // starting point for "switch camera" so cycling doesn't force a re-acquire here.
  const resolvedIdRef = useRef<string | undefined>(undefined);

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
          onResultRef.current(found.data);
          return; // stop scanning
        }
      }
      if (!cancelled) raf = requestAnimationFrame(scan);
    };

    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("No camera API available in this context");
        }
        // Prefer the rear camera on phones. `ideal` (not `exact`) so a desktop
        // with only a front-facing webcam still works. An explicit deviceId from
        // the switch button overrides the facingMode preference.
        const video: MediaTrackConstraints = deviceId
          ? { deviceId: { exact: deviceId } }
          : { facingMode: { ideal: "environment" } };
        stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        // Device labels are only populated once permission is granted, so list
        // the cameras here (drives whether the switch button is shown).
        const cams = (await navigator.mediaDevices.enumerateDevices()).filter(
          (d) => d.kind === "videoinput",
        );
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        setCameras(cams);
        // Record which camera was actually chosen so "switch" knows where to
        // start cycling, without triggering another acquire of the same stream.
        if (!deviceId) {
          resolvedIdRef.current = stream.getVideoTracks()[0]?.getSettings().deviceId;
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          setError(null);
          raf = requestAnimationFrame(scan);
        }
      } catch (err) {
        const name = err instanceof DOMException ? err.name : "";
        setError(
          name === "NotAllowedError"
            ? "Camera permission denied. Allow camera access (macOS: System Settings → Privacy & Security → Camera) or use Paste."
            : name === "NotFoundError"
              ? "No camera found. Use Paste instead."
              : err instanceof Error
                ? err.message
                : "Camera unavailable",
        );
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [deviceId]);

  // Cycle to the next camera. Re-acquiring with an exact deviceId lets the user
  // recover when the auto-picked lens (e.g. a phone's wide/depth camera) can't
  // focus on the QR.
  const switchCamera = useCallback(() => {
    if (cameras.length < 2) return;
    const currentId = deviceId ?? resolvedIdRef.current;
    const i = cameras.findIndex((c) => c.deviceId === currentId);
    setDeviceId(cameras[(i + 1) % cameras.length].deviceId);
  }, [cameras, deviceId]);

  if (error) return <div className="muted scan-error">Camera error: {error}. Use paste instead.</div>;
  return (
    <>
      <video ref={videoRef} className="scanner" muted playsInline />
      {cameras.length > 1 && (
        <button type="button" className="ghost switch-camera" onClick={switchCamera}>
          Switch camera
        </button>
      )}
    </>
  );
}
