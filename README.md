#  BlackBar

**BlackBar** is a fully client-side PDF redaction tool that detects, reviews, and permanently removes sensitive information — all directly in your browser.

> No uploads. No servers. Your data never leaves your device.

---

## FEATURES

### 1. Smart Auto-Detection

* Detects sensitive data automatically using pattern matching:

  * Emails
  * Phone numbers
  * Credit card numbers
  * IP addresses
* Highlights detected regions with precise bounding boxes

---

### 2. Manual Redaction

* Draw custom redaction boxes anywhere on the document
* Drag to reposition
* Hover to delete
* Pixel-accurate placement

---

### 3. Undo / Redo System

* Full editing history support
* Keyboard shortcuts:

  * `Ctrl/Cmd + Z` → Undo
  * `Ctrl/Cmd + Shift + Z` or `Ctrl + Y` → Redo

---

### 4. Multi-Page Support

* Works across all pages of a PDF
* Independent redactions per page
* Smooth page-by-page rendering

---

### 5. Review Mode

* Toggle between:

  * **Edit Mode** → create & adjust redactions
  * **Review Mode** → verify final output
  * **Original View** → compare with unredacted version

---

### 6. Permanent Redaction (NOT fake overlays)

* Redactions are **burned into the exported PDF**
* Uses canvas rendering + PDF reconstruction
* Ensures data cannot be recovered

---

### 7. Fully Client-Side

* No backend, no API calls
* All processing happens locally using:

  * `pdfjs-dist` (parsing & rendering)
  * `pdf-lib` (exporting final PDF)

---

### 8. Clean, Professional UI

* Dark, distraction-free interface
* Drag-and-drop upload
* Real-time feedback & status indicators
* Trust banner (privacy-first messaging)

---

## TECH STACK

* **Framework:** React (Next.js)
* **PDF Rendering:** pdfjs-dist
* **PDF Export:** pdf-lib
* **Deployment:** Vercel

---

## INSTALLATION

```bash
git clone https://github.com/tanmaymishrab0c9/blackbar
cd blackbar
npm install
npm run dev
```

---

## 🌐 LIVE DEMO

https://blackbar.vercel.app/

---

## HOW IT WORKS

1. PDF is loaded locally in the browser
2. Each page is rendered onto a canvas
3. Text content is extracted with positional data
4. Auto-detection scans for sensitive patterns
5. Users can:

   * adjust detected boxes
   * draw new ones manually
6. On export:

   * PDF is re-rendered
   * redactions are drawn directly onto it
   * new PDF is generated with **irreversible masking**

---

## CURRENT LIMITATIONS

* Pattern-based detection (no AI yet)
* Accuracy depends on PDF text structure
* Complex layouts may require manual adjustments

---

## FUTURE IMROVEMENTS

* AI-based PII detection
* Optional encrypted cloud mode
* Smart suggestions & confidence scores

---

##  Why BlackBar?

Most tools:

* Upload your files ❌
* Store sensitive data ❌

**BlackBar:**

> Local-first. Privacy-first. 

---

## Author

**Tanmay Mishra**

---

## Contributing

PRs, ideas, and improvements are welcome!

---

## License

MIT License
