"use client";

import { useState, useRef, useEffect, useCallback } from "react";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const normaliseBox = (b) => ({
  ...b,
  x: b.width < 0 ? b.x + b.width : b.x,
  y: b.height < 0 ? b.y + b.height : b.y,
  width: Math.abs(b.width),
  height: Math.abs(b.height),
});

const PATTERNS = [
  { label: "Email",       regex: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g },
  { label: "Phone",       regex: /(\+?1[\s.\-]?)?(\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})/g },
  { label: "SSN",         regex: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g },
  { label: "Credit Card", regex: /\b(?:\d[ \-]?){13,19}\b/g },
  { label: "IP Address",  regex: /\b\d{1,3}(\.\d{1,3}){3}\b/g },
];

export default function PDFRedactor() {
  const [fileObject, setFileObject]   = useState(null);
  const [fileName,   setFileName]     = useState("");
  const [pages,      setPages]        = useState([]);
  const [boxes,      setBoxes]        = useState([]);
  const [status,     setStatus]       = useState("idle");
  const [mode,       setMode]         = useState("edit");
  const [viewMode,   setViewMode]     = useState("redacted");
  const [activeBox,  setActiveBox]    = useState(null);
  const [isDrawing,  setIsDrawing]    = useState(false);
  const [history,    setHistory]      = useState([]);
  const [redoStack,  setRedoStack]    = useState([]);
  const [hoveredBox, setHoveredBox]   = useState(null);
  const [detecting,  setDetecting]    = useState(false);
  const [detectCount,setDetectCount]  = useState(null);
  const [showTrust,  setShowTrust]    = useState(true);

  const canvasRefs    = useRef([]);
  const containerRefs = useRef([]);
  const dragOffset    = useRef({ x: 0, y: 0 });
  const snapshotRef   = useRef([]);
  const activePageRef = useRef(null);
  const pdfRef        = useRef(null);

  const loadPDF = async (file) => {
    if (!file) return;
    setBoxes([]); setPages([]); setHistory([]); setRedoStack([]);
    canvasRefs.current = []; containerRefs.current = [];
    setActiveBox(null); setIsDrawing(false); setDetectCount(null);
    setFileObject(file); setFileName(file.name); setStatus("loading");

    const buffer = await file.arrayBuffer();
    const pdfjsLib = await import("pdfjs-dist");
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url
    ).toString();

    const pdf = await pdfjsLib.getDocument(new Uint8Array(buffer)).promise;
    pdfRef.current = { pdf, pdfjsLib };
    const loaded = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      loaded.push({ page, viewport: page.getViewport({ scale: 1.5 }) });
    }
    setPages(loaded);
    setStatus("ready");
  };

  const handleFileChange = (e) => loadPDF(e.target.files?.[0]);
  const handleDrop = (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f?.type === "application/pdf") loadPDF(f);
  };

  useEffect(() => {
    (async () => {
      for (let i = 0; i < pages.length; i++) {
        const canvas = canvasRefs.current[i];
        const p = pages[i];
        if (!canvas || !p) continue;
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        await p.page.render({ canvasContext: ctx, viewport: p.viewport }).promise;
      }
    })();
  }, [pages]);

  const pushHistory = useCallback((snap) => {
    setHistory((h) => [...h, snap]);
    setRedoStack([]);
  }, []);

  const undo = useCallback(() => {
    if (!history.length) return;
    setRedoStack((r) => [boxes, ...r]);
    setBoxes(history[history.length - 1]);
    setHistory((h) => h.slice(0, -1));
  }, [history, boxes]);

  const redo = useCallback(() => {
    if (!redoStack.length) return;
    setHistory((h) => [...h, boxes]);
    setBoxes(redoStack[0]);
    setRedoStack((r) => r.slice(1));
  }, [redoStack, boxes]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "z") { e.preventDefault(); undo(); }
      if ((e.metaKey || e.ctrlKey) && (e.key === "y" || (e.shiftKey && e.key === "z"))) { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // ── FIXED Auto-Detect ──────────────────────────────────────────────────────
  // Strategy: render each page to a temp canvas at the SAME scale the preview
  // canvas uses, extract text items with their PDF-space transforms, then
  // convert PDF-space → canvas-space using the page viewport's transform matrix.
  // This gives pixel-accurate bounding boxes that align with what the user sees.
  const autoDetect = useCallback(async () => {
    if (!pdfRef.current || !pages.length) return;
    setDetecting(true);
    const { pdf } = pdfRef.current;
    const newBoxes = [];

    for (let i = 0; i < pages.length; i++) {
      const { page, viewport } = pages[i];
      const canvas = canvasRefs.current[i];
      if (!canvas) continue;

      // The preview canvas dimensions = viewport.width × viewport.height
      // (pdfjs renders at exactly those dimensions when scale=1.5 above)
      const canvasW = canvas.width;
      const canvasH = canvas.height;

      // viewport.transform = [sx, 0, 0, sy, tx, ty] (affine: scale + translate)
      // PDF-space point (px, py) → canvas-space (cx, cy):
      //   cx = px * sx + tx
      //   cy = canvasH - (py * sy_abs + ty_contribution)   (PDF y is bottom-up)
      // The easiest correct way: use viewport.convertToViewportPoint(px, py)
      // which returns [cx, cy] in CSS/canvas pixels (y already flipped).

      const textContent = await page.getTextContent();

      for (const item of textContent.items) {
        const str = item.str;
        if (!str || !str.trim()) continue;

        // item.transform = [a, b, c, d, e, f]  (standard PDF CTM)
        // e, f = translation (PDF-space origin of this text item)
        // a, d = scale components (approximate font size via |d| or |a|)
        const [a, b, c, d, e, f] = item.transform;
        const fontSizePDF = Math.sqrt(d * d + b * b); // handles rotation

        // Convert baseline origin to canvas coords
        const [baseX, baseY] = viewport.convertToViewportPoint(e, f);

        // Character width in canvas pixels
        // item.width is the total text width in PDF user units (unscaled)
        // viewport.scale converts PDF units → canvas pixels
        const totalWidthCanvas = item.width * viewport.scale;
        const charWidthCanvas  = str.length > 0 ? totalWidthCanvas / str.length : 0;

        // Font height in canvas pixels
        const fontHeightCanvas = fontSizePDF * viewport.scale;

        for (const { regex } of PATTERNS) {
          regex.lastIndex = 0;
          let match;
          while ((match = regex.exec(str)) !== null) {
            const matchLen    = match[0].length;
            const charOffset  = match.index * charWidthCanvas;
            const matchWidth  = matchLen * charWidthCanvas;

            // baseY is the text baseline in canvas coords (y-axis already flipped)
            // Ascenders sit above the baseline; descenders below.
            // A generous box: top = baseline - ascender, height = full em
            const boxX = baseX + charOffset;
            const boxY = baseY - fontHeightCanvas * 1.05;
            const boxW = Math.max(matchWidth, 12);
            const boxH = fontHeightCanvas * 1.45;

            // Sanity-clamp to canvas bounds
            if (
              boxX < 0 || boxY < 0 ||
              boxX + boxW > canvasW + 4 ||
              boxY + boxH > canvasH + 4
            ) continue;

            newBoxes.push({
              id:     Date.now() + Math.random(),
              page:   i,
              x:      Math.max(0, boxX),
              y:      Math.max(0, boxY),
              width:  Math.min(boxW, canvasW - Math.max(0, boxX)),
              height: Math.min(boxH, canvasH - Math.max(0, boxY)),
              auto:   true,
            });
          }
        }
      }
    }

    pushHistory(boxes);
    setBoxes((prev) => [...prev, ...newBoxes]);
    setDetectCount(newBoxes.length);
    setDetecting(false);
    setTimeout(() => setDetectCount(null), 4000);
  }, [pages, boxes, pushHistory]);

  const posRelToContainer = (clientX, clientY, pageIndex) => {
    const el = containerRefs.current[pageIndex];
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  };

  const handleMouseDown = useCallback((e, pageIndex) => {
    if (mode !== "edit") return;
    e.preventDefault();
    const { x, y } = posRelToContainer(e.clientX, e.clientY, pageIndex);
    snapshotRef.current = boxes;
    activePageRef.current = pageIndex;

    const hit = boxes.find(
      (b) => b.page === pageIndex &&
        x >= b.x && x <= b.x + b.width &&
        y >= b.y && y <= b.y + b.height
    );

    if (hit) {
      setActiveBox(hit.id);
      setIsDrawing(false);
      dragOffset.current = { x: x - hit.x, y: y - hit.y };
    } else {
      const id = Date.now();
      setBoxes((prev) => [...prev, { id, page: pageIndex, x, y, width: 0, height: 0 }]);
      setActiveBox(id);
      setIsDrawing(true);
    }
  }, [mode, boxes]);

  const handleMouseMove = useCallback((e, pageIndex) => {
    if (mode !== "edit" || activeBox === null) return;
    const { x, y } = posRelToContainer(e.clientX, e.clientY, pageIndex);
    const canvas = canvasRefs.current[pageIndex];
    const maxW = canvas?.width  ?? 9999;
    const maxH = canvas?.height ?? 9999;

    setBoxes((prev) => prev.map((b) => {
      if (b.id !== activeBox) return b;
      if (!isDrawing) {
        return {
          ...b,
          x: clamp(x - dragOffset.current.x, 0, maxW - b.width),
          y: clamp(y - dragOffset.current.y, 0, maxH - b.height),
        };
      }
      return { ...b, width: x - b.x, height: y - b.y };
    }));
  }, [mode, activeBox, isDrawing]);

  const handleMouseUp = useCallback(() => {
    if (activeBox !== null) {
      setBoxes((prev) =>
        prev
          .map(normaliseBox)
          .filter((b) => b.id !== activeBox || (b.width > 4 && b.height > 4))
      );
      pushHistory(snapshotRef.current);
    }
    setActiveBox(null);
    setIsDrawing(false);
    activePageRef.current = null;
  }, [activeBox, pushHistory]);

  useEffect(() => {
    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, [handleMouseUp]);

  const deleteBox = useCallback((id) => {
    if (mode !== "edit") return;
    pushHistory(boxes);
    setBoxes((prev) => prev.filter((b) => b.id !== id));
    setHoveredBox(null);
  }, [mode, boxes, pushHistory]);

  const exportPDF = async () => {
    if (!fileObject) return;
    setStatus("exporting");
    const buffer = await fileObject.arrayBuffer();
    const pdfjsLib = await import("pdfjs-dist");
    const pdf = await pdfjsLib.getDocument(new Uint8Array(buffer)).promise;
    const { PDFDocument } = await import("pdf-lib");
    const newPdf = await PDFDocument.create();

    for (let i = 1; i <= pdf.numPages; i++) {
      const page   = await pdf.getPage(i);
      const vp     = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      canvas.width = vp.width; canvas.height = vp.height;
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport: vp }).promise;

      const preview = canvasRefs.current[i - 1];
      const sx = vp.width  / preview.width;
      const sy = vp.height / preview.height;

      boxes.filter((b) => b.page === i - 1).forEach((b) => {
        ctx.fillStyle = "#000";
        ctx.fillRect(b.x * sx, b.y * sy, b.width * sx, b.height * sy);
      });

      const img     = await newPdf.embedPng(canvas.toDataURL());
      const newPage = newPdf.addPage([vp.width, vp.height]);
      newPage.drawImage(img, { x: 0, y: 0, width: vp.width, height: vp.height });
    }

    const bytes = await newPdf.save();
    const blob  = new Blob([bytes], { type: "application/pdf" });
    const a     = document.createElement("a");
    a.href      = URL.createObjectURL(blob);
    a.download  = `redacted-${fileName}`;
    a.click();
    setStatus("done");
    setTimeout(() => setStatus("ready"), 3000);
  };

  const hasFile      = pages.length > 0;
  const isLoading    = status === "loading";
  const isExporting  = status === "exporting";
  const totalRedactions = boxes.length;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
          --bg: #0d0d0d;
          --surface0: #141414;
          --surface1: #1c1c1c;
          --surface2: #242424;
          --surface3: #2e2e2e;
          --border: rgba(255,255,255,0.07);
          --border-strong: rgba(255,255,255,0.13);
          --text-primary: #f0f0f0;
          --text-secondary: rgba(240,240,240,0.6);
          --text-disabled: rgba(240,240,240,0.35);
          --text-hint: rgba(240,240,240,0.45);

          --primary: #FF5722;
          --primary-light: #FF8A65;
          --primary-dark: #E64A19;
          --primary-surface: rgba(255,87,34,0.1);
          --primary-surface-hover: rgba(255,87,34,0.18);

          --blue: #5B9CF6;
          --blue-surface: rgba(91,156,246,0.1);
          --blue-surface-hover: rgba(91,156,246,0.18);

          --green: #4ADE80;
          --green-surface: rgba(74,222,128,0.08);

          --amber: #FBBF24;
          --amber-surface: rgba(251,191,36,0.1);

          --red: #F87171;
          --red-surface: rgba(248,113,113,0.12);

          --elevation1: 0 1px 3px rgba(0,0,0,0.5);
          --elevation2: 0 4px 12px rgba(0,0,0,0.5);
          --elevation3: 0 8px 28px rgba(0,0,0,0.55);
          --elevation4: 0 20px 60px rgba(0,0,0,0.65);

          --radius: 8px;
          --radius-sm: 5px;
          --radius-lg: 12px;
          --radius-pill: 100px;

          --font: 'Geist', 'SF Pro Display', system-ui, sans-serif;
          --font-mono: 'Geist Mono', 'SF Mono', monospace;

          --transition: all 0.18s cubic-bezier(0.4, 0, 0.2, 1);
        }

        body { background: var(--bg); overflow-x: hidden; }

        .app {
          min-height: 100vh;
          background: var(--bg);
          color: var(--text-primary);
          font-family: var(--font);
          display: flex;
          flex-direction: column;
          font-size: 13.5px;
          line-height: 1.5;
        }

        /* ── Professional Trust Bar ── */
        .trust-banner {
          background: var(--surface0);
          border-bottom: 1px solid var(--border);
          padding: 0 20px;
          height: 34px;
          display: flex;
          align-items: center;
          gap: 0;
          font-size: 11.5px;
          color: var(--text-disabled);
          font-family: var(--font-mono);
          letter-spacing: 0.02em;
          position: relative;
        }
        .trust-items {
          display: flex;
          align-items: center;
          gap: 0;
          flex: 1;
        }
        .trust-item {
          display: flex;
          align-items: center;
          gap: 7px;
          padding: 0 20px;
          height: 34px;
          border-right: 1px solid var(--border);
          color: var(--text-disabled);
          transition: color 0.15s;
        }
        .trust-item:first-child { padding-left: 0; }
        .trust-item:hover { color: var(--text-secondary); }
        .trust-dot {
          width: 5px; height: 5px; border-radius: 50%;
          background: var(--green);
          box-shadow: 0 0 5px var(--green);
          flex-shrink: 0;
          opacity: 0.85;
        }
        .trust-dot-amber { background: var(--amber); box-shadow: 0 0 5px var(--amber); }
        .trust-dot-blue  { background: var(--blue);  box-shadow: 0 0 5px var(--blue); }
        .trust-spacer { flex: 1; }
        .trust-close {
          background: none; border: none;
          color: var(--text-disabled);
          font-size: 13px; cursor: pointer; line-height: 1;
          transition: var(--transition);
          padding: 4px 6px;
          border-radius: 4px;
          font-family: var(--font-mono);
        }
        .trust-close:hover { color: var(--text-secondary); background: var(--surface2); }

        /* ── App Bar ── */
        .appbar {
          position: sticky; top: 0; z-index: 100;
          background: var(--surface1);
          box-shadow: 0 1px 0 var(--border), 0 2px 12px rgba(0,0,0,0.4);
          height: 56px;
          padding: 0 16px;
          display: flex; align-items: center; gap: 8px;
        }

        .brand {
          display: flex; align-items: center; gap: 0;
          margin-right: 4px; flex-shrink: 0;
        }
        .brand-name {
          font-size: 15px; font-weight: 700;
          color: var(--text-primary);
          letter-spacing: -0.02em;
          line-height: 1;
          font-family: var(--font);
        }
        .brand-tag {
          font-size: 9px; font-weight: 500;
          color: var(--text-disabled);
          letter-spacing: 0.1em;
          line-height: 1;
          margin-top: 3px;
          font-family: var(--font-mono);
        }
        .brand-stack { display: flex; flex-direction: column; gap: 2px; }

        .divider {
          width: 1px; height: 24px;
          background: var(--border-strong);
          margin: 0 4px; flex-shrink: 0;
        }
        .spacer { flex: 1; }

        /* ── Buttons ── */
        .btn {
          display: inline-flex; align-items: center; justify-content: center; gap: 6px;
          padding: 0 14px; height: 34px;
          border-radius: var(--radius-sm);
          font-family: var(--font);
          font-size: 12.5px; font-weight: 500; letter-spacing: -0.01em;
          cursor: pointer; border: none;
          transition: var(--transition);
          white-space: nowrap; user-select: none;
          position: relative; overflow: hidden;
          flex-shrink: 0;
        }
        .btn svg { flex-shrink: 0; }

        .btn-outlined {
          background: transparent;
          border: 1px solid var(--border-strong);
          color: var(--text-secondary);
        }
        .btn-outlined:not(:disabled):hover {
          background: var(--surface2);
          border-color: rgba(255,255,255,0.22);
          color: var(--text-primary);
        }
        .btn-outlined:disabled { opacity: 0.3; cursor: not-allowed; pointer-events: none; }

        .btn-tonal-primary {
          background: transparent;
          color: var(--text-secondary);
          border: 1px solid var(--border-strong);
        }
        .btn-tonal-primary:not(:disabled):hover {
          background: var(--primary-surface);
          border-color: rgba(255,87,34,0.3);
          color: var(--primary-light);
        }
        .btn-tonal-primary.active {
          background: var(--primary-surface);
          border-color: rgba(255,87,34,0.4);
          color: var(--primary-light);
        }

        .btn-tonal-blue {
          background: transparent;
          color: var(--text-secondary);
          border: 1px solid var(--border-strong);
        }
        .btn-tonal-blue:not(:disabled):hover {
          background: var(--blue-surface);
          border-color: rgba(91,156,246,0.35);
          color: var(--blue);
        }
        .btn-tonal-blue:disabled { opacity: 0.3; cursor: not-allowed; pointer-events: none; }

        .btn-tonal-green {
          background: transparent;
          color: var(--text-secondary);
          border: 1px solid var(--border-strong);
        }
        .btn-tonal-green:not(:disabled):hover {
          background: rgba(74,222,128,0.08);
          border-color: rgba(74,222,128,0.3);
          color: var(--green);
        }
        .btn-tonal-green.active {
          background: rgba(74,222,128,0.08);
          border-color: rgba(74,222,128,0.35);
          color: var(--green);
        }

        .btn-filled {
          background: var(--primary);
          color: #fff;
          font-weight: 600;
          letter-spacing: -0.01em;
          border: 1px solid transparent;
          box-shadow: 0 2px 8px rgba(255,87,34,0.3);
        }
        .btn-filled:not(:disabled):hover {
          background: var(--primary-light);
          box-shadow: 0 4px 16px rgba(255,87,34,0.4);
        }
        .btn-filled:disabled { opacity: 0.35; cursor: not-allowed; pointer-events: none; box-shadow: none; }

        .btn-upload {
          background: transparent;
          color: var(--text-secondary);
          border: 1px solid var(--border-strong);
        }
        .btn-upload:hover {
          background: var(--surface2);
          border-color: rgba(255,255,255,0.22);
          color: var(--text-primary);
        }
        .btn-upload label { cursor: pointer; display: flex; align-items: center; gap: 6px; width: 100%; height: 100%; padding: 0 14px; }

        .filename-chip {
          display: flex; align-items: center; gap: 6px;
          padding: 3px 10px; border-radius: var(--radius-sm);
          background: var(--surface2);
          border: 1px solid var(--border);
          font-size: 11px; color: var(--text-hint);
          max-width: 140px; font-family: var(--font-mono);
        }
        .filename-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .filename-dot {
          width: 5px; height: 5px; border-radius: 50%;
          background: var(--green); flex-shrink: 0;
          box-shadow: 0 0 4px var(--green);
        }

        .count-chip {
          display: flex; align-items: center; gap: 5px;
          padding: 3px 10px; border-radius: var(--radius-sm);
          background: var(--primary-surface);
          border: 1px solid rgba(255,87,34,0.2);
          font-size: 11.5px; font-weight: 600;
          color: var(--primary-light);
          font-family: var(--font-mono);
        }

        /* ── Drop Zone ── */
        .drop-wrap {
          flex: 1; display: flex; align-items: center; justify-content: center;
          padding: 48px 20px;
          background: radial-gradient(ellipse at 50% 40%, rgba(255,87,34,0.03) 0%, transparent 60%);
        }
        .drop-zone {
          display: flex; flex-direction: column; align-items: center; gap: 24px;
          padding: 60px 60px;
          border: 1px dashed rgba(255,255,255,0.12);
          border-radius: var(--radius-lg);
          cursor: pointer;
          transition: var(--transition);
          max-width: 480px; width: 100%; text-align: center;
          background: var(--surface0);
          box-shadow: var(--elevation2);
          position: relative; overflow: hidden;
        }
        .drop-zone:hover {
          border-color: rgba(255,87,34,0.4);
          background: var(--surface1);
          box-shadow: var(--elevation3), 0 0 0 1px rgba(255,87,34,0.08);
          transform: translateY(-1px);
        }

        .drop-icon-wrap {
          width: 64px; height: 64px;
          border-radius: var(--radius);
          background: var(--surface2);
          border: 1px solid var(--border-strong);
          display: flex; align-items: center; justify-content: center;
          font-size: 26px;
          transition: var(--transition);
        }
        .drop-zone:hover .drop-icon-wrap {
          background: var(--primary-surface);
          border-color: rgba(255,87,34,0.3);
        }

        .drop-title {
          font-size: 20px; font-weight: 600;
          color: var(--text-primary);
          letter-spacing: -0.03em;
          line-height: 1.2;
        }
        .drop-sub {
          font-size: 13px; color: var(--text-secondary);
          line-height: 1.7; max-width: 300px;
        }
        .drop-sub strong { color: var(--text-primary); font-weight: 500; }

        .drop-meta {
          display: flex; gap: 20px; align-items: center;
          font-size: 11px; font-family: var(--font-mono);
          color: var(--text-disabled);
          padding-top: 4px;
          border-top: 1px solid var(--border);
          width: 100%;
          justify-content: center;
        }
        .drop-meta-item { display: flex; align-items: center; gap: 5px; }

        /* ── Canvas Area ── */
        .canvas-area { flex: 1; padding: 20px; background: var(--bg); }

        .canvas-toolbar {
          display: flex; align-items: center; gap: 10px;
          margin-bottom: 14px;
          padding: 8px 12px;
          background: var(--surface1);
          border-radius: var(--radius-sm);
          box-shadow: var(--elevation1);
          border: 1px solid var(--border);
          flex-wrap: wrap;
        }

        .toolbar-label {
          font-size: 10.5px; color: var(--text-disabled);
          text-transform: uppercase; letter-spacing: 0.1em;
          font-weight: 500; flex-shrink: 0; font-family: var(--font-mono);
        }
        .toolbar-sep { width: 1px; height: 20px; background: var(--border-strong); }
        .toolbar-spacer { flex: 1; min-width: 10px; }

        .view-toggle {
          display: flex;
          background: var(--surface2);
          border-radius: var(--radius-sm);
          padding: 2px;
          border: 1px solid var(--border);
        }
        .vtoggle-btn {
          padding: 4px 12px;
          border-radius: 3px;
          border: none; cursor: pointer;
          font-family: var(--font); font-size: 11.5px; font-weight: 500;
          transition: var(--transition); letter-spacing: -0.01em;
        }
        .vtoggle-inactive { background: transparent; color: var(--text-disabled); }
        .vtoggle-inactive:hover { color: var(--text-secondary); background: rgba(255,255,255,0.04); }
        .vtoggle-redacted { background: var(--primary); color: #fff; box-shadow: 0 1px 4px rgba(255,87,34,0.3); }
        .vtoggle-original { background: var(--amber); color: #1a1a1a; }

        /* Hint bar */
        .hint-bar {
          display: flex; align-items: center; gap: 8px;
          padding: 7px 12px; margin-bottom: 14px;
          background: var(--surface0);
          border-radius: var(--radius-sm);
          border: 1px solid var(--border);
          border-left: 2px solid;
          font-size: 11.5px; font-family: var(--font-mono);
          color: var(--text-disabled);
          letter-spacing: 0.01em;
        }
        .hint-edit   { border-left-color: var(--primary); }
        .hint-review { border-left-color: var(--green); }
        .hint-orig   { border-left-color: var(--amber); }

        /* Page rendering */
        .page-label {
          font-size: 10.5px; color: var(--text-disabled);
          text-align: center; margin-bottom: 8px;
          letter-spacing: 0.08em; text-transform: uppercase;
          font-weight: 500; font-family: var(--font-mono);
        }
        .page-wrapper { display: flex; justify-content: center; margin-bottom: 28px; }

        .page-inner {
          position: relative; display: inline-block;
          border-radius: var(--radius-sm);
          box-shadow: 0 0 0 1px var(--border-strong), var(--elevation4);
          overflow: hidden;
        }
        canvas { display: block; }

        .original-badge {
          position: absolute; top: 10px; left: 10px; z-index: 20;
          background: rgba(251,191,36,0.1);
          border: 1px solid rgba(251,191,36,0.3);
          color: var(--amber);
          font-size: 10px; font-weight: 600;
          letter-spacing: 0.1em; text-transform: uppercase;
          padding: 3px 8px; border-radius: 3px;
          pointer-events: none; font-family: var(--font-mono);
        }

        /* ── Redaction Boxes ── */
        .rbox { position: absolute; }
        .rbox-del {
          position: absolute; top: -9px; right: -9px;
          width: 20px; height: 20px; border-radius: 50%;
          background: var(--red);
          color: #fff;
          font-size: 13px; line-height: 20px; text-align: center;
          cursor: pointer; border: 1.5px solid var(--surface1);
          opacity: 0; transform: scale(0.5);
          transition: opacity 0.12s, transform 0.12s cubic-bezier(0.34,1.56,0.64,1);
          z-index: 10;
          box-shadow: 0 2px 6px rgba(248,113,113,0.4);
        }
        .rbox:hover .rbox-del { opacity: 1; transform: scale(1); }

        /* ── Status Bar ── */
        .status-bar {
          height: 28px;
          background: var(--surface0);
          border-top: 1px solid var(--border);
          display: flex; align-items: center; gap: 10px;
          padding: 0 16px;
          font-size: 11px; color: var(--text-disabled);
          font-family: var(--font-mono);
        }
        .status-dot {
          width: 6px; height: 6px; border-radius: 50%;
          flex-shrink: 0;
        }
        .dot-idle     { background: var(--surface3); }
        .dot-ready    { background: var(--green); box-shadow: 0 0 5px var(--green); }
        .dot-loading  { background: var(--amber); animation: blink 0.9s infinite; }
        .dot-exporting{ background: var(--blue); animation: blink 0.5s infinite; }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.2} }

        /* Loading */
        .loading-wrap {
          flex: 1; display: flex; flex-direction: column; align-items: center;
          justify-content: center; gap: 14px;
          font-size: 13px; color: var(--text-secondary);
          font-family: var(--font-mono);
        }
        .spinner {
          width: 28px; height: 28px;
          border: 2px solid var(--surface3);
          border-top-color: var(--primary);
          border-radius: 50%;
          animation: spin 0.7s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* Toasts */
        .toast {
          position: fixed; bottom: 36px; left: 50%; transform: translateX(-50%);
          padding: 10px 18px; border-radius: var(--radius-sm);
          font-size: 12.5px; font-weight: 500; font-family: var(--font-mono);
          display: flex; align-items: center; gap: 10px;
          box-shadow: var(--elevation4);
          animation: slideUp 0.2s cubic-bezier(0.34,1.56,0.64,1);
          z-index: 999; white-space: nowrap;
        }
        .toast-export {
          background: var(--surface2);
          border: 1px solid var(--border-strong);
          color: var(--text-secondary);
        }
        .toast-detect {
          background: rgba(91,156,246,0.12);
          border: 1px solid rgba(91,156,246,0.3);
          color: var(--blue);
        }
        @keyframes slideUp {
          from { opacity:0; transform: translateX(-50%) translateY(10px) scale(0.97); }
          to   { opacity:1; transform: translateX(-50%) translateY(0) scale(1); }
        }

        input[type="file"] { display: none; }

        ::-webkit-scrollbar { width: 5px; }
        ::-webkit-scrollbar-track { background: var(--bg); }
        ::-webkit-scrollbar-thumb { background: var(--surface3); border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: var(--border-strong); }
      `}</style>

      <div className="app">

        {/* ── Professional Trust Bar ── */}
        {showTrust && (
          <div className="trust-banner">
            <div className="trust-items">
              <div className="trust-item">
                <div className="trust-dot" />
                <span>Zero upload — files never leave your device</span>
              </div>
              <div className="trust-item">
                <div className="trust-dot trust-dot-blue" />
                <span>100% client-side processing</span>
              </div>
              <div className="trust-item">
                <div className="trust-dot trust-dot-amber" />
                <span>Redactions burned in — not hidden overlays</span>
              </div>
            </div>
            <div className="trust-spacer" />
            <button className="trust-close" onClick={() => setShowTrust(false)}>✕</button>
          </div>
        )}

        {/* ── App Bar ── */}
        <div className="appbar">
          <div className="brand" style={{marginRight: 8}}>
            <div className="brand-stack">
              <span className="brand-name">BlackBar</span>
              <span className="brand-tag">PRIVATE · LOCAL</span>
            </div>
          </div>

          <div className="divider" />

          {/* Upload */}
          <div className="btn btn-upload" style={{padding: 0, height: 34}}>
            <label>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
              </svg>
              Open PDF
              <input type="file" accept="application/pdf" onChange={handleFileChange} />
            </label>
          </div>

          {fileName && (
            <div className="filename-chip">
              <div className="filename-dot" />
              <span title={fileName}>{fileName}</span>
            </div>
          )}

          <div className="divider" />

          {/* Undo / Redo */}
          <button className="btn btn-outlined" onClick={undo} disabled={!history.length} title="Undo (⌘Z)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 10h10a5 5 0 0 1 0 10H9"/><path d="M3 10l4-4M3 10l4 4"/>
            </svg>
            Undo
          </button>
          <button className="btn btn-outlined" onClick={redo} disabled={!redoStack.length} title="Redo (⌘Y)">
            Redo
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 10H11a5 5 0 0 0 0 10h4"/><path d="M21 10l-4-4M21 10l-4 4"/>
            </svg>
          </button>

          <div className="divider" />

          {/* Edit / Review mode */}
          <button className={`btn btn-tonal-primary ${mode === "edit" ? "active" : ""}`} onClick={() => setMode("edit")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
            Edit
          </button>
          <button className={`btn btn-tonal-green ${mode === "review" ? "active" : ""}`} onClick={() => { setMode("review"); setViewMode("redacted"); }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M20.188 10.934A9.966 9.966 0 0121 12c-1.657 4.56-5.373 7-9 7s-7.343-2.44-9-7c.211-.58.49-1.135.832-1.66"/>
            </svg>
            Review
          </button>

          <div className="divider" />

          {/* Auto Detect */}
          <button className="btn btn-tonal-blue" onClick={autoDetect} disabled={!hasFile || isLoading || detecting}>
            {detecting ? (
              <>
                <div className="spinner" style={{width:11,height:11,borderWidth:1.5,borderTopColor:'var(--blue)'}} />
                Scanning…
              </>
            ) : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                </svg>
                Auto-Detect
              </>
            )}
          </button>

          {totalRedactions > 0 && (
            <div className="count-chip">
              {totalRedactions} box{totalRedactions !== 1 ? "es" : ""}
            </div>
          )}

          <div className="spacer" />

          {/* Export CTA */}
          <button className="btn btn-filled" style={{height: 34, padding: '0 18px', fontSize: 13}} onClick={exportPDF} disabled={!hasFile || isExporting || isLoading}>
            {isExporting ? (
              <>
                <div className="spinner" style={{width:12,height:12,borderWidth:1.5,borderTopColor:'#fff'}} />
                Exporting…
              </>
            ) : (
              <>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>
                </svg>
                Export PDF
              </>
            )}
          </button>
        </div>

        {/* ── Body ── */}

        {!hasFile && !isLoading && (
          <div className="drop-wrap">
            <label className="drop-zone" onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}>
              <div className="drop-icon-wrap">📄</div>
              <div>
                <p className="drop-title">Drop a PDF to redact</p>
              </div>
              <p className="drop-sub">
                <strong>Draw boxes</strong> over sensitive content, or use <strong>Auto-Detect</strong> to scan for PII automatically.
              </p>
              <div className="drop-meta">
                <div className="drop-meta-item">
                  <div className="trust-dot" style={{width:4,height:4}} />
                  <span>zero upload</span>
                </div>
                <div className="drop-meta-item">
                  <div className="trust-dot trust-dot-blue" style={{width:4,height:4}} />
                  <span>client-side only</span>
                </div>
                <div className="drop-meta-item">
                  <div className="trust-dot trust-dot-amber" style={{width:4,height:4}} />
                  <span>permanent redaction</span>
                </div>
              </div>
              <input type="file" accept="application/pdf" onChange={handleFileChange} />
            </label>
          </div>
        )}

        {isLoading && (
          <div className="loading-wrap">
            <div className="spinner" />
            <span>Rendering pages locally…</span>
          </div>
        )}

        {hasFile && !isLoading && (
          <div className="canvas-area">
            <div className="canvas-toolbar">
              <span className="toolbar-label">Document</span>
              <span style={{fontSize:12,color:'var(--text-secondary)',fontFamily:'var(--font-mono)'}}>
                {pages.length}p
              </span>
              <div className="toolbar-sep" />
              <span className="toolbar-label">View</span>
              <div className="view-toggle">
                <button className={`vtoggle-btn ${viewMode === "redacted" ? "vtoggle-redacted" : "vtoggle-inactive"}`} onClick={() => setViewMode("redacted")}>Redacted</button>
                <button className={`vtoggle-btn ${viewMode === "original" ? "vtoggle-original" : "vtoggle-inactive"}`} onClick={() => setViewMode("original")}>Original</button>
              </div>
              <div className="toolbar-spacer" />
              <span style={{fontSize:11, color:'var(--text-disabled)', fontFamily:'var(--font-mono)'}}>
                ⌘Z undo · ⌘⇧Z redo
              </span>
            </div>

            {viewMode === "original" ? (
              <div className="hint-bar hint-orig">
                ⚠ Original view — redactions hidden. Switch to Redacted to edit.
              </div>
            ) : mode === "edit" ? (
              <div className="hint-bar hint-edit">
                ✎ Drag to draw · hover box to delete · drag to reposition · Auto-Detect scans for PII
              </div>
            ) : (
              <div className="hint-bar hint-review">
                ✓ Review mode — redactions opaque. Switch to Edit to make changes.
              </div>
            )}

            {pages.map((p, i) => (
              <div key={i}>
                <p className="page-label">Page {i + 1} of {pages.length}</p>
                <div className="page-wrapper">
                  <div
                    className="page-inner"
                    ref={(el) => (containerRefs.current[i] = el)}
                    onMouseDown={(e) => viewMode === "redacted" && handleMouseDown(e, i)}
                    onMouseMove={(e) => viewMode === "redacted" && handleMouseMove(e, i)}
                    style={{ cursor: viewMode === "original" ? "default" : mode === "edit" ? "crosshair" : "default" }}
                  >
                    <canvas
                      ref={(el) => (canvasRefs.current[i] = el)}
                      width={p.viewport.width}
                      height={p.viewport.height}
                      style={{ display: "block", pointerEvents: "none" }}
                    />

                    {viewMode === "original" && (
                      <div className="original-badge">ORIGINAL</div>
                    )}

                    {viewMode === "redacted" && boxes.filter((b) => b.page === i).map((b) => {
                      const isActive = b.id === activeBox && isDrawing;
                      return (
                        <div
                          key={b.id}
                          className="rbox"
                          onMouseEnter={() => setHoveredBox(b.id)}
                          onMouseLeave={() => setHoveredBox(null)}
                          style={{
                            left: b.x, top: b.y,
                            width: b.width, height: b.height,
                            // Drawing = very transparent blue tint; review = solid black; edit = near-opaque black
                            background: isActive
                              ? "rgba(91,156,246,0.18)"
                              : mode === "review"
                                ? "#000"
                                : "rgba(0,0,0,0.82)",
                            outline: isActive
                              ? "1.5px solid rgba(91,156,246,0.7)"
                              : mode === "edit"
                                ? hoveredBox === b.id
                                  ? "1.5px solid var(--red)"
                                  : b.auto
                                    ? "1.5px solid rgba(91,156,246,0.55)"
                                    : "1.5px solid rgba(255,87,34,0.55)"
                                : "none",
                            borderRadius: 2,
                            boxShadow: mode === "edit" && hoveredBox === b.id
                              ? "0 0 0 3px rgba(248,113,113,0.15)" : "none",
                            transition: "background 0.1s, box-shadow 0.12s, outline 0.12s",
                          }}
                        >
                          {mode === "edit" && !isActive && (
                            <button
                              className="rbox-del"
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={(e) => { e.stopPropagation(); deleteBox(b.id); }}
                            >×</button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Status Bar ── */}
        <div className="status-bar">
          <div className={`status-dot ${
            status === "ready" || status === "done" ? "dot-ready"
            : status === "loading" ? "dot-loading"
            : status === "exporting" ? "dot-exporting"
            : "dot-idle"
          }`} />
          <span>
            {status === "idle"      && "no file loaded"}
            {status === "loading"   && "rendering locally…"}
            {status === "ready"     && `${pages.length}p · ${totalRedactions} redaction${totalRedactions !== 1 ? "s" : ""}`}
            {status === "exporting" && "burning redactions into pdf…"}
            {status === "done"      && "export complete — redactions burned in permanently ✓"}
          </span>
          <span style={{marginLeft:"auto", color:"var(--text-disabled)"}}>local only · never uploaded</span>
        </div>

        {/* Toasts */}
        {isExporting && (
          <div className="toast toast-export">
            <div className="spinner" style={{width:13,height:13,borderWidth:1.5}} />
            burning redactions into pdf…
          </div>
        )}

        {detectCount !== null && (
          <div className="toast toast-detect">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            {detectCount} match{detectCount !== 1 ? "es" : ""} detected — review and adjust
          </div>
        )}

      </div>
    </>
  );
}