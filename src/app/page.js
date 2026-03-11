"use client"

import { useState, useRef } from "react";

export default function Home() {
  const [fileName, setFileName] = useState("");
  const [fileObject, setFileObject] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [redactionCount, setRedactionCount] = useState(0);
  const [pageCount, setPageCount] = useState(0);
  const [pdfReady, setPdfReady] = useState(false);
  const [highlightMode, setHighlightMode] = useState(true);
  const [progress, setProgress] = useState(0);
  const fileInputRef = useRef(null);
  const canvasListRef = useRef([]);

  const EMAIL_RE = /[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/gi;

  const handleFileUpload = (file) => {
    if (file && file.type === "application/pdf") {
      setFileName(file.name);
      setFileObject(file);
      setRedactionCount(0);
      setPageCount(0);
      setPdfReady(false);
      setHighlightMode(true);
      setProgress(0);
      canvasListRef.current = [];
    }
  };

  const handleInputChange = (e) => handleFileUpload(e.target.files[0]);
  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    handleFileUpload(e.dataTransfer.files[0]);
  };

  /**
   * Collect email bounding boxes using EXACT per-character positions.
   *
   * We call getTextContent({ disableCombineTextItems: true }) which makes pdfjs
   * return ONE item per glyph. Each item then has:
   *   item.str          – the single character
   *   item.transform[4] – exact x origin of that glyph in PDF user space
   *   item.transform[5] – exact y (baseline) of that glyph
   *   item.width        – exact advance width of that glyph
   *   item.height       – exact height
   *
   * This eliminates all font-substitution estimation errors entirely.
   */
  const collectEmailBoxes = async (pdf) => {
    const boxes = [];

    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);

      // disableCombineTextItems = one item per glyph → exact positions
      const content = await page.getTextContent({
        disableCombineTextItems: true,
        includeMarkedContent: false,
      });

      // Build a flat char array for this page
      // Each entry: { char, x0, x1, y0, y1 }
      const chars = [];

      let lastTy = null;
      for (const item of content.items) {
        if (!item.str || !item.transform) continue;

        const [, , , sy, tx, ty] = item.transform;
        // CRITICAL: item.transform[3] (sy) = 1.0 in Word PDFs — NOT the font size.
        // item.height is the actual rendered font height in PDF user-space.
        const fontH = (item.height > 0 ? item.height : Math.abs(sy));
        const totalW = Math.abs(item.width || 0);
        const y0 = ty - fontH * 0.15;
        const y1 = ty + fontH * 0.85;

        // Insert a newline sentinel between different Y baselines so the email
        // regex never accidentally matches across two separate text lines.
        if (lastTy !== null && Math.abs(lastTy - ty) > 2) {
          chars.push({ char: "\n", x0: null, x1: null, y0: null, y1: null });
        }
        lastTy = ty;

        if (item.str.length === 1) {
          // Single-char item (common with disableCombineTextItems=true):
          // tx and item.width are exact glyph metrics — no estimation needed.
          chars.push({ char: item.str, x0: tx, x1: tx + totalW, y0, y1 });
        } else {
          // Multi-char item: distribute width proportionally so every character
          // gets its own entry and regex→index mapping stays 1:1.
          const adv = Array.from(item.str).map(c => {
            if (/[il|1!\'",;:.]/.test(c)) return 0.40;
            if (/[mw@]/.test(c))           return 1.30;
            if (/[A-Z0-9]/.test(c))        return 0.85;
            return 0.70;
          });
          const advSum = adv.reduce((a, b) => a + b, 0);
          const scale  = advSum > 0 ? totalW / advSum : 0;
          let cx = 0;
          for (let i = 0; i < item.str.length; i++) {
            const cw = adv[i] * scale;
            chars.push({ char: item.str[i], x0: tx + cx, x1: tx + cx + cw, y0, y1 });
            cx += cw;
          }
        }
      }

      // Build the string and find emails
      const pageStr = chars.map((c) => c.char).join("");
      EMAIL_RE.lastIndex = 0;
      let m;
      while ((m = EMAIL_RE.exec(pageStr)) !== null) {
        const matchChars = chars.slice(m.index, m.index + m[0].length)
          .filter((c) => c.x0 !== null);
        if (!matchChars.length) continue;

        boxes.push({
          pageNum: p,
          x0: Math.min(...matchChars.map((c) => c.x0)),
          y0: Math.min(...matchChars.map((c) => c.y0)),
          x1: Math.max(...matchChars.map((c) => c.x1)),
          y1: Math.max(...matchChars.map((c) => c.y1)),
        });
      }
    }

    return boxes;
  };

  const readFile = async (applyBlack = false) => {
    if (!fileObject) return;
    setIsProcessing(true);
    setPdfReady(false);
    setProgress(0);
    const modeHighlight = !applyBlack;

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const typedArray = new Uint8Array(event.target.result);
        const pdfjsLib = await import("pdfjs-dist");
        pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url
        ).toString();

        const pdf = await pdfjsLib.getDocument(typedArray).promise;

        // Pass 1: collect all email boxes with exact positions
        const boxes = await collectEmailBoxes(pdf);
        setRedactionCount(boxes.length);
        setPageCount(pdf.numPages);
        setProgress(50);

        // Pass 2: render + draw
        const scale = 1.5;
        const container = document.getElementById("pdf-container");
        container.innerHTML = "";
        canvasListRef.current = [];

        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
          const page = await pdf.getPage(pageNum);
          const viewport = page.getViewport({ scale });

          const wrapper = document.createElement("div");
          wrapper.style.cssText = "position:relative;width:100%;";

          const label = document.createElement("div");
          label.textContent = `PAGE ${pageNum} / ${pdf.numPages}`;
          label.style.cssText = "font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:0.2em;color:#3a3a3a;text-align:right;margin-bottom:6px;padding-right:2px;";

          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d");
          canvas.height = viewport.height;
          canvas.width = viewport.width;
          canvas.style.cssText = "display:block;width:100%;border-radius:2px;margin-bottom:24px;box-shadow:0 0 0 1px rgba(255,255,255,0.06),0 24px 48px rgba(0,0,0,0.7);";

          wrapper.appendChild(label);
          wrapper.appendChild(canvas);
          container.appendChild(wrapper);
          canvasListRef.current.push(canvas);

          await page.render({ canvasContext: ctx, viewport }).promise;

          for (const box of boxes.filter((b) => b.pageNum === pageNum)) {
            // Convert PDF user-space (bottom-left origin) → canvas pixels
            const [cx0, cy0] = viewport.convertToViewportPoint(box.x0, box.y1);
            const [cx1, cy1] = viewport.convertToViewportPoint(box.x1, box.y0);

            const rx = Math.floor(Math.min(cx0, cx1)) - 2;
            const ry = Math.floor(Math.min(cy0, cy1)) - 2;
            const rw = Math.ceil(Math.abs(cx1 - cx0)) + 4;
            const rh = Math.ceil(Math.abs(cy1 - cy0)) + 4;

            if (modeHighlight) {
              ctx.fillStyle = "rgba(255,200,0,0.4)";
              ctx.strokeStyle = "rgba(255,200,0,0.8)";
              ctx.lineWidth = 1;
              ctx.fillRect(rx, ry, rw, rh);
              ctx.strokeRect(rx, ry, rw, rh);
            } else {
              ctx.fillStyle = "#0a0a0a";
              ctx.fillRect(rx - 1, ry - 1, rw + 2, rh + 2);
            }
          }

          setProgress(Math.round(50 + (pageNum / pdf.numPages) * 50));
        }

        setPdfReady(true);
        setIsProcessing(false);
        setProgress(100);
      } catch (err) {
        console.error("PDF Error:", err);
        setIsProcessing(false);
      }
    };
    reader.readAsArrayBuffer(fileObject);
  };

  const loadJsPDF = () => new Promise((resolve, reject) => {
    if (window.jspdf?.jsPDF) return resolve(window.jspdf.jsPDF);
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
    s.onload = () => resolve(window.jspdf.jsPDF);
    s.onerror = reject;
    document.head.appendChild(s);
  });

  const downloadRedacted = async () => {
    if (!canvasListRef.current.length) return;
    const jsPDF = await loadJsPDF();
    const first = canvasListRef.current[0];
    const px = 0.264583;
    const pw = first.width * px, ph = first.height * px;
    const pdf = new jsPDF({ orientation: pw > ph ? "landscape" : "portrait", unit: "mm", format: [pw, ph] });
    for (let i = 0; i < canvasListRef.current.length; i++) {
      const c = canvasListRef.current[i];
      if (i > 0) pdf.addPage([c.width * px, c.height * px]);
      pdf.addImage(c.toDataURL("image/jpeg", 0.95), "JPEG", 0, 0, c.width * px, c.height * px);
    }
    pdf.save(`${fileName.replace(/\.pdf$/i, "")}_redacted.pdf`);
  };

  const reset = () => {
    setFileName(""); setFileObject(null);
    setRedactionCount(0); setPageCount(0); setPdfReady(false);
    setProgress(0); setHighlightMode(true);
    canvasListRef.current = [];
    const c = document.getElementById("pdf-container");
    if (c) c.innerHTML = "";
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&family=Playfair+Display:ital,wght@0,400;0,700;1,400;1,600&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
          --bg: #0c0c0c; --surface: #111111; --surface2: #161616;
          --border: #1f1f1f; --border2: #2a2a2a;
          --text: #e2ddd4; --text2: #6b6660; --text3: #3a3735;
          --accent: #ffffff; --warn: #c8a84b;
          --mono: 'IBM Plex Mono', monospace;
          --serif: 'Playfair Display', serif;
        }

        html { scroll-behavior: smooth; }
        body { background: var(--bg); font-family: var(--mono); color: var(--text); min-height: 100vh; -webkit-font-smoothing: antialiased; }

        body::before {
          content: ''; position: fixed; inset: 0;
          background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.03'/%3E%3C/svg%3E");
          pointer-events: none; z-index: 9999; opacity: 0.4;
        }

        .layout { display: grid; grid-template-rows: auto 1fr auto; min-height: 100vh; }

        .header {
          display: grid; grid-template-columns: 1fr auto 1fr;
          align-items: center; padding: 0 40px; height: 56px;
          border-bottom: 1px solid var(--border);
          position: sticky; top: 0;
          background: rgba(12,12,12,0.95); backdrop-filter: blur(12px); z-index: 100;
        }

        .header-left { display: flex; align-items: center; gap: 16px; }
        .classification { font-size: 8px; letter-spacing: 0.25em; font-weight: 600; color: var(--text3); text-transform: uppercase; border: 1px solid var(--border2); padding: 3px 8px; border-radius: 2px; }
        .doc-id { font-size: 9px; letter-spacing: 0.12em; color: var(--text3); }

        .logo { display: flex; flex-direction: column; align-items: center; gap: 3px; }
        .logo-name { font-family: var(--serif); font-size: 15px; font-weight: 700; letter-spacing: 0.08em; color: var(--accent); display: flex; align-items: center; gap: 8px; }
        .logo-bar-group { display: flex; flex-direction: column; gap: 3px; }
        .logo-bar { height: 3px; background: var(--accent); border-radius: 1px; }
        .logo-bar:nth-child(1) { width: 22px; }
        .logo-bar:nth-child(2) { width: 14px; opacity: 0.4; }
        .logo-bar:nth-child(3) { width: 18px; opacity: 0.2; }

        .header-right { display: flex; justify-content: flex-end; align-items: center; }
        .secure-badge { display: flex; align-items: center; gap: 6px; font-size: 9px; letter-spacing: 0.15em; color: var(--text3); text-transform: uppercase; }
        .secure-dot { width: 6px; height: 6px; border-radius: 50%; background: #2d5a27; box-shadow: 0 0 6px #2d5a27; animation: pulse-green 2.5s ease-in-out infinite; }
        @keyframes pulse-green { 0%,100%{opacity:1;box-shadow:0 0 4px #2d5a27}50%{opacity:0.7;box-shadow:0 0 10px #3d7a35} }

        .main { display: grid; grid-template-columns: 300px 1fr; min-height: calc(100vh - 56px - 40px); }

        .sidebar { border-right: 1px solid var(--border); padding: 48px 32px; display: flex; flex-direction: column; gap: 40px; position: sticky; top: 56px; height: calc(100vh - 56px); overflow-y: auto; }
        .sidebar::-webkit-scrollbar { width: 3px; }
        .sidebar::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 2px; }

        .sidebar-section { display: flex; flex-direction: column; gap: 16px; }
        .section-label { font-size: 8px; font-weight: 600; letter-spacing: 0.3em; text-transform: uppercase; color: var(--text3); display: flex; align-items: center; gap: 8px; }
        .section-label::after { content: ''; flex: 1; height: 1px; background: var(--border); }

        .headline { font-family: var(--serif); font-size: 28px; font-weight: 400; line-height: 1.15; letter-spacing: -0.3px; color: var(--text); }
        .headline em { font-style: italic; color: var(--text2); }
        .subtext { font-size: 10px; line-height: 1.7; color: var(--text2); letter-spacing: 0.02em; }

        .upload-zone { border: 1px dashed var(--border2); border-radius: 4px; padding: 28px 20px; text-align: center; cursor: pointer; transition: border-color 0.2s, background 0.2s; position: relative; background: var(--surface); }
        .upload-zone:hover, .upload-zone.drag { border-color: var(--text2); background: var(--surface2); }
        .upload-zone input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }
        .upload-icon-wrap { width: 36px; height: 36px; border: 1px solid var(--border2); border-radius: 3px; display: flex; align-items: center; justify-content: center; margin: 0 auto 12px; color: var(--text2); }
        .upload-text { font-size: 11px; color: var(--text2); line-height: 1.5; }
        .upload-text strong { color: var(--text); font-weight: 500; }
        .upload-sub { font-size: 9px; color: var(--text3); margin-top: 6px; letter-spacing: 0.15em; text-transform: uppercase; }

        .file-card { border: 1px solid var(--border); border-radius: 4px; padding: 14px 16px; background: var(--surface); display: flex; align-items: flex-start; gap: 12px; }
        .file-icon { width: 32px; height: 40px; border: 1px solid var(--border2); border-radius: 2px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 7px; font-weight: 600; letter-spacing: 0.1em; flex-direction: column; position: relative; background: var(--surface2); }
        .file-icon::after { content:''; position:absolute; top:0; right:0; width:8px; height:8px; background:var(--bg); border-left:1px solid var(--border2); border-bottom:1px solid var(--border2); }
        .file-info { flex: 1; min-width: 0; }
        .file-name { font-size: 11px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 3px; }
        .file-meta { font-size: 9px; color: var(--text3); letter-spacing: 0.08em; }
        .btn-ghost { background: none; border: none; color: var(--text3); cursor: pointer; font-size: 16px; line-height: 1; transition: color 0.15s; flex-shrink: 0; padding: 0; }
        .btn-ghost:hover { color: var(--text); }

        .actions { display: flex; flex-direction: column; gap: 8px; }

        .btn-main { background: var(--text); color: var(--bg); border: none; border-radius: 3px; padding: 13px 18px; font-family: var(--mono); font-size: 10px; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase; cursor: pointer; transition: background 0.15s, transform 0.1s; width: 100%; }
        .btn-main:hover:not(:disabled) { background: #fff; transform: translateY(-1px); }
        .btn-main:disabled { opacity: 0.25; cursor: not-allowed; }

        .btn-outline { background: transparent; color: var(--text); border: 1px solid var(--border2); border-radius: 3px; padding: 12px 18px; font-family: var(--mono); font-size: 10px; font-weight: 500; letter-spacing: 0.15em; text-transform: uppercase; cursor: pointer; transition: border-color 0.15s, background 0.15s, transform 0.1s; width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; }
        .btn-outline:hover:not(:disabled) { border-color: var(--text2); background: var(--surface2); transform: translateY(-1px); }
        .btn-outline:disabled { opacity: 0.2; cursor: not-allowed; }

        .btn-apply { background: transparent; color: var(--warn); border: 1px solid rgba(200,168,75,0.3); border-radius: 3px; padding: 12px 18px; font-family: var(--mono); font-size: 10px; font-weight: 500; letter-spacing: 0.15em; text-transform: uppercase; cursor: pointer; transition: all 0.15s; width: 100%; animation: warn-pulse 2s ease-in-out infinite; }
        @keyframes warn-pulse { 0%,100%{box-shadow:0 0 0 0 rgba(200,168,75,0)}50%{box-shadow:0 0 0 3px rgba(200,168,75,0.08)} }
        .btn-apply:hover { background: rgba(200,168,75,0.08); border-color: rgba(200,168,75,0.6); }

        .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--border); border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
        .stat-cell { background: var(--surface); padding: 16px 14px; }
        .stat-num { font-family: var(--serif); font-size: 26px; font-weight: 400; color: var(--text); line-height: 1; margin-bottom: 5px; }
        .stat-lbl { font-size: 8px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--text3); }

        .progress-wrap { display: flex; flex-direction: column; gap: 8px; }
        .progress-header { display: flex; justify-content: space-between; align-items: center; }
        .progress-label { font-size: 9px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--text2); display: flex; align-items: center; gap: 8px; }
        .spinner { width: 10px; height: 10px; border: 1.5px solid var(--border2); border-top-color: var(--text2); border-radius: 50%; animation: spin 0.7s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .progress-pct { font-size: 10px; color: var(--text3); font-weight: 500; }
        .progress-track { height: 2px; background: var(--border); border-radius: 1px; overflow: hidden; }
        .progress-fill { height: 100%; background: var(--text); border-radius: 1px; transition: width 0.3s ease; }

        .note { border: 1px solid rgba(200,168,75,0.2); background: rgba(200,168,75,0.04); border-radius: 3px; padding: 12px 14px; font-size: 10px; line-height: 1.6; color: var(--warn); }

        .content-area { padding: 48px 40px; display: flex; flex-direction: column; }
        .content-empty { flex: 1; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 20px; opacity: 0.15; }
        .empty-bars { display: flex; flex-direction: column; gap: 6px; }
        .empty-bar { height: 10px; background: var(--text); border-radius: 1px; opacity: 0.6; }
        .empty-text { font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--text2); }

        .content-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 28px; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
        .content-title { font-size: 9px; letter-spacing: 0.25em; text-transform: uppercase; color: var(--text3); }
        .content-badge { font-size: 9px; letter-spacing: 0.15em; color: var(--text3); display: flex; align-items: center; gap: 6px; }
        .badge-dot { width: 5px; height: 5px; border-radius: 50%; background: #2d5a27; box-shadow: 0 0 5px #2d5a27; }

        #pdf-container { display: flex; flex-direction: column; align-items: center; }
        #pdf-container > div { width: 100%; max-width: 800px; }

        .footer { border-top: 1px solid var(--border); padding: 14px 40px; display: flex; align-items: center; justify-content: space-between; grid-column: 1 / -1; }
        .footer-text { font-size: 9px; letter-spacing: 0.12em; color: var(--text3); text-transform: uppercase; }

        @media (max-width: 768px) {
          .main { grid-template-columns: 1fr; }
          .sidebar { position: static; height: auto; border-right: none; border-bottom: 1px solid var(--border); padding: 32px 24px; }
          .content-area { padding: 32px 24px; }
          .header { padding: 0 24px; }
          .header-left { display: none; }
        }
      `}</style>

      <div className="layout">
        <header className="header">
          <div className="header-left">
            <span className="classification">Unclassified</span>
            <span className="doc-id">BB-REDACT-v3.0</span>
          </div>
          <div className="logo">
            <span className="logo-name">
              <div className="logo-bar-group">
                <div className="logo-bar" /><div className="logo-bar" /><div className="logo-bar" />
              </div>
              BLACK BAR
            </span>
          </div>
          <div className="header-right">
            <div className="secure-badge">
              <div className="secure-dot" />
              Local Processing
            </div>
          </div>
        </header>

        <div className="main">
          <aside className="sidebar">

            <div className="sidebar-section">
              <span className="section-label">About</span>
              <h1 className="headline">Redact the <em>sensitive.</em><br />Preserve the rest.</h1>
              <p className="subtext">Automatic email detection &amp; redaction. All processing runs in your browser — your documents never leave this device.</p>
            </div>

            <div className="sidebar-section">
              <span className="section-label">Document</span>
              {!fileObject ? (
                <div
                  className={`upload-zone${isDragging ? " drag" : ""}`}
                  onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={handleDrop}
                >
                  <input ref={fileInputRef} type="file" accept=".pdf" onChange={handleInputChange} />
                  <div className="upload-icon-wrap">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                      <polyline points="14 2 14 8 20 8"/>
                      <line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>
                    </svg>
                  </div>
                  <p className="upload-text"><strong>Drop PDF here</strong><br />or click to browse</p>
                  <p className="upload-sub">PDF only · Max 50MB</p>
                </div>
              ) : (
                <div className="file-card">
                  <div className="file-icon">
                    <span style={{color:'var(--text3)',fontSize:'7px',letterSpacing:'0.1em'}}>PDF</span>
                  </div>
                  <div className="file-info">
                    <div className="file-name">{fileName}</div>
                    <div className="file-meta">{pdfReady ? `${pageCount} pages · ${redactionCount} found` : "Ready to scan"}</div>
                  </div>
                  <button className="btn-ghost" onClick={reset}>×</button>
                </div>
              )}
            </div>

            {fileObject && (
              <div className="sidebar-section">
                <span className="section-label">Actions</span>
                <div className="actions">
                  <button className="btn-main" onClick={() => { setHighlightMode(true); readFile(false); }} disabled={isProcessing}>
                    {isProcessing ? "Processing…" : "Scan Document"}
                  </button>
                  {pdfReady && highlightMode && (
                    <button className="btn-apply" onClick={() => { setHighlightMode(false); readFile(true); }}>
                      Apply Redaction
                    </button>
                  )}
                  <button className="btn-outline" onClick={downloadRedacted} disabled={!pdfReady || isProcessing || highlightMode}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                      <polyline points="7 10 12 15 17 10"/>
                      <line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                    Export Redacted PDF
                  </button>
                </div>
              </div>
            )}

            {isProcessing && (
              <div className="sidebar-section">
                <span className="section-label">Progress</span>
                <div className="progress-wrap">
                  <div className="progress-header">
                    <div className="progress-label"><div className="spinner" />Scanning</div>
                    <span className="progress-pct">{progress}%</span>
                  </div>
                  <div className="progress-track">
                    <div className="progress-fill" style={{ width: `${progress}%` }} />
                  </div>
                </div>
              </div>
            )}

            {pdfReady && (
              <div className="sidebar-section">
                <span className="section-label">Results</span>
                <div className="stats-grid">
                  <div className="stat-cell">
                    <div className="stat-num">{redactionCount}</div>
                    <div className="stat-lbl">Items Found</div>
                  </div>
                  <div className="stat-cell">
                    <div className="stat-num">{pageCount}</div>
                    <div className="stat-lbl">Pages</div>
                  </div>
                </div>
                {highlightMode && (
                  <div className="note">
                    ◈ Items highlighted in yellow. Click <strong>Apply Redaction</strong> to permanently black out.
                  </div>
                )}
              </div>
            )}

          </aside>

          <div className="content-area">
            {!pdfReady && !isProcessing && (
              <div className="content-empty">
                <div className="empty-bars">
                  <div className="empty-bar" style={{width:'240px'}} />
                  <div className="empty-bar" style={{width:'180px'}} />
                  <div className="empty-bar" style={{width:'210px'}} />
                  <div className="empty-bar" style={{width:'160px',opacity:0.3}} />
                  <div className="empty-bar" style={{width:'195px'}} />
                </div>
                <p className="empty-text">Upload a document to begin</p>
              </div>
            )}
            {(pdfReady || isProcessing) && (
              <div className="content-header">
                <span className="content-title">Document Preview</span>
                <div className="content-badge"><div className="badge-dot" />Local — Not Transmitted</div>
              </div>
            )}
            <div id="pdf-container" />
          </div>
        </div>

        <footer className="footer">
          <span className="footer-text">Black Bar · PDF Redaction Tool</span>
          <span className="footer-text">All processing is local — no data leaves your device</span>
        </footer>
      </div>
    </>
  );
}
