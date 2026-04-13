# OCR Pipeline

How Sherlock extracts text from scanned/image-based PDFs.

## Pipeline overview

```
PDF file
  --> pdf-parse (JS library, fast)
      |
      |-- text found (>100 chars) --> use extracted text, done
      |
      |-- little/no text (<100 chars) --> OCR fallback:
            |
            PDF --> pdftoppm (100 DPI, PNG per page)
                --> tesseract (--psm 6, per page)
                --> concatenated text with page markers
```

**Key files:**
- `server/lib/extract.js` — `extractText()`, `extractTextWithOcrInfo()`, `ocrPdf()`
- `server/lib/extract-worker.js` — subprocess wrapper with timeout/SIGKILL protection

## How it works

1. **pdf-parse first**: Every PDF goes through `pdf-parse` (JS library) which extracts embedded text from the PDF structure. This is fast and handles natively-digital PDFs.

2. **OCR fallback**: If pdf-parse returns <100 chars, the PDF is likely scanned/image-based. The OCR pipeline kicks in:
   - **pdftoppm** (from poppler) converts each page to a PNG image at 100 DPI
   - **tesseract** runs on each page image with `--psm 6` (assume uniform block of text)
   - Results are concatenated with `--- Page N ---` separators

3. **Subprocess isolation**: Workers (PST, chat, ZIP) invoke extraction via `extract-worker.js` as a child process with a 15-second timeout + SIGKILL. This prevents CPU-bound parsers from blocking the event loop. The `textocr` mode returns both text and OCR metadata (attempted/succeeded/timeMs).

## System dependencies

- **poppler** (`pdftoppm`): `brew install poppler`
- **tesseract**: `brew install tesseract`

Both are checked at runtime — if missing, OCR is skipped gracefully with a console warning.

## DPI selection: why 100 DPI

Benchmarked on 2026-04-12 across multiple PDFs of varying sizes (341K/12 pages to 112MB/564 pages).

### Timing results

| File | DPI | pdftoppm | tesseract | Total |
|------|-----|----------|-----------|-------|
| 112 MB, 564 pg | 100 | 120s | 35s | 155s |
| 112 MB, 564 pg | 200 | 301s | 36s | 338s |
| 103 MB, 422 pg | 100 | 83s | 26s | 110s |
| 103 MB, 422 pg | 200 | 194s | 29s | 223s |
| 3.8 MB, 21 pg | 100 | 7s | 16s | 23s |
| 3.8 MB, 21 pg | 200 | 22s | 25s | 47s |
| 341 KB, 12 pg | 100 | 2s | 8s | 10s |
| 341 KB, 12 pg | 200 | 5s | 14s | 19s |

### Key findings

- **pdftoppm is the bottleneck** — image conversion accounts for 70-90% of total OCR time
- **100 DPI is ~2x faster overall** — conversion time roughly halves
- **Tesseract time is nearly identical** at both DPIs (lower-res images = fewer pixels to process, but same number of pages)
- **Text quality is equivalent** — character counts differ by <10%, and the readable content is the same. Both DPIs produce equal noise on non-text regions (logos, images)

### Why not go lower?

At 72 DPI or below, small text (footnotes, captions, fine print) starts to lose legibility for tesseract. 100 DPI is the sweet spot where standard document text (10-12pt) remains crisp enough for reliable OCR.

## Limits and edge cases

- **50 MB file size cap**: PDFs over 50 MB are skipped entirely (both pdf-parse and OCR) to avoid memory issues
- **1 minute pdftoppm timeout**: Very large PDFs (500+ pages) may hit this. The timeout prevents runaway conversions
- **1 minute per-page tesseract timeout**: Individual pages that hang are skipped; other pages still process
- **Image-heavy PDFs with some text**: If pdf-parse extracts >100 chars, OCR is not attempted even if most pages are scanned. The threshold is intentionally low to avoid unnecessary OCR on text-native PDFs
- **Non-Latin scripts**: tesseract defaults to English. Additional language packs can be installed but are not configured

## Modes

| Mode | Function | Returns | Used by |
|------|----------|---------|---------|
| `text` | `extractText()` | plain string | direct upload, simple extraction |
| `textocr` | `extractTextWithOcrInfo()` | `{ text, ocr: { attempted, succeeded, timeMs } }` | PST worker, chat worker, ZIP worker (Phase 2) |
| `meta` | `extractMetadata()` | metadata object | document metadata extraction |
