// "Set the problem": instead of myTA reading the problem off the screen, upload a photo or PDF of it, or snap a picture of the page
// with the camera. Optional: say which problem it is ("3b") when the file has several.
import { useEffect, useRef, useState } from 'react';
import { Brand } from '../shared/Brand';

const api = window.myta.problem;
type Picked = { name: string; kind: 'pdf' | 'image'; preview: string | null; sizeKb: number };

export function Problem() {
  const [which, setWhich] = useState('');
  const [picked, setPicked] = useState<Picked | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (stream && video.current) {
      video.current.srcObject = stream;
      void video.current.play().catch(() => undefined);
    }
    return () => undefined;
  }, [stream]);
  useEffect(() => () => stream?.getTracks().forEach((t) => t.stop()), [stream]);

  const pick = async () => {
    setError(null);
    const r = await api.pick();
    if (!r) return;
    if ('error' in r) return setError(r.error);
    setPicked(r);
    setPhoto(null);
  };

  const openCamera = async () => {
    setError(null);
    try {
      setStream(await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 }, facingMode: 'environment' }, audio: false }));
    } catch {
      setError('The camera is blocked or busy (another app may be using it). Upload a photo or PDF instead.');
    }
  };

  const snap = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    setPhoto(c.toDataURL('image/jpeg', 0.9));
    setPicked(null);
    stream?.getTracks().forEach((t) => t.stop());
    setStream(null);
  };

  const use = async () => {
    setBusy(true);
    const r = await api.submit({ which, photo: photo ?? undefined, useFile: !!picked });
    setBusy(false);
    if (r.error) setError(r.error);
  };

  const ready = !!picked || !!photo;
  return (
    <main className="page narrow">
      <header className="hero">
        <Brand size={34} tagline="Show me the problem" />
        <p className="muted small">
          myTA normally reads the problem off your screen. If it's on paper, in a PDF, or somewhere else, give it to me here. Either way I'll watch your work in the
          window you write in.
        </p>
      </header>

      <section className="card">
        <div className="row">
          <button className="primary" onClick={() => void pick()}>
            Upload a photo or PDF
          </button>
          <button onClick={() => (stream ? (stream.getTracks().forEach((t) => t.stop()), setStream(null)) : void openCamera())}>{stream ? 'Close camera' : 'Take a picture'}</button>
        </div>

        {stream && (
          <div className="cam-box" style={{ marginTop: 12 }}>
            <video ref={video} muted playsInline className="problemcam" />
            <button className="primary" onClick={snap}>
              Snap it
            </button>
          </div>
        )}

        {photo && <img className="problem-preview" src={photo} alt="Your photo of the problem" />}
        {picked?.preview && <img className="problem-preview" src={picked.preview} alt={picked.name} />}
        {picked && !picked.preview && (
          <p className="chip" style={{ marginTop: 12 }}>
            📄 {picked.name} ({picked.sizeKb} KB)
          </p>
        )}

        <label style={{ marginTop: 14 }}>
          Which problem? <span className="muted small">(optional, e.g. "3b" when there are several)</span>
          <input type="text" value={which} maxLength={40} onChange={(e) => setWhich(e.target.value)} />
        </label>

        <div className="row">
          <button className="primary" disabled={!ready || busy} onClick={() => void use()}>
            Use this problem
          </button>
          <button className="ghost" onClick={() => void api.useScreen({ which })}>
            Read it from my screen instead
          </button>
        </div>
        {error && <p className="small error">{error}</p>}
      </section>
    </main>
  );
}
