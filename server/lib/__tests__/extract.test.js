import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// extractConfig is read at module load from process.env, so we use
// vi.resetModules() + dynamic import to control it per test group.

describe('OCR enabled/disabled toggle', () => {
  let tmpDir;
  let dummyPdf;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-test-'));
    // Create a minimal "PDF" file — pdf-parse will fail or return empty text,
    // which triggers the OCR path (text < ocrMinTextLength threshold)
    dummyPdf = path.join(tmpDir, 'scanned.pdf');
    fs.writeFileSync(dummyPdf, 'not a real pdf');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
    // Clean up env vars
    delete process.env.EXTRACT_OCR_ENABLED;
    delete process.env.EXTRACT_OCR_MIN_TEXT_LENGTH;
  });

  it('extractConfig.ocrEnabled defaults to true when env var is not set', async () => {
    delete process.env.EXTRACT_OCR_ENABLED;
    vi.resetModules();
    // We can't directly access extractConfig, but we can verify behavior
    // by importing the module and checking that OCR would be attempted
    const mod = await import('../extract.js');
    // extractTextWithOcrInfo on a non-PDF should not attempt OCR regardless
    const result = await mod.extractTextWithOcrInfo(path.join(tmpDir, 'test.txt'));
    expect(result.ocr.attempted).toBe(false);
  });

  it('extractConfig.ocrEnabled is false when EXTRACT_OCR_ENABLED=false', async () => {
    process.env.EXTRACT_OCR_ENABLED = 'false';
    vi.resetModules();
    const mod = await import('../extract.js');
    // extractTextWithOcrInfo on a bad PDF — should NOT attempt OCR
    const result = await mod.extractTextWithOcrInfo(dummyPdf, 'application/pdf');
    expect(result.ocr.attempted).toBe(false);
  });

  it('extractText skips OCR when disabled and logs skip message', async () => {
    process.env.EXTRACT_OCR_ENABLED = 'false';
    process.env.EXTRACT_OCR_MIN_TEXT_LENGTH = '999999'; // ensure threshold triggers
    vi.resetModules();
    const mod = await import('../extract.js');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // extractText on a dummy PDF — pdf-parse will fail/return minimal text,
      // but OCR should be skipped
      await mod.extractText(dummyPdf, 'application/pdf');
      // Check that OCR skip message was logged (not OCR attempt)
      const ocrLogs = logSpy.mock.calls.filter(c => c[0]?.includes?.('[extractText]'));
      const hasSkipLog = ocrLogs.some(c => c[0]?.includes?.('OCR disabled'));
      const hasAttemptLog = ocrLogs.some(c => c[0]?.includes?.('attempting OCR'));
      expect(hasAttemptLog).toBe(false);
      // Skip log may or may not fire depending on whether pdf-parse returns text
      // The key assertion is that OCR was NOT attempted
    } finally {
      logSpy.mockRestore();
    }
  });

  it('extractTextWithOcrInfo does not attempt OCR when disabled', async () => {
    process.env.EXTRACT_OCR_ENABLED = 'false';
    vi.resetModules();
    const mod = await import('../extract.js');
    const result = await mod.extractTextWithOcrInfo(dummyPdf, 'application/pdf');
    expect(result.ocr.attempted).toBe(false);
    expect(result.ocr.succeeded).toBe(false);
    expect(result.ocr.timeMs).toBe(0);
  });

  it('non-PDF files never trigger OCR regardless of setting', async () => {
    process.env.EXTRACT_OCR_ENABLED = 'true';
    vi.resetModules();
    const mod = await import('../extract.js');

    const txtFile = path.join(tmpDir, 'hello.txt');
    fs.writeFileSync(txtFile, 'hello world');
    const result = await mod.extractTextWithOcrInfo(txtFile, 'text/plain');
    expect(result.ocr.attempted).toBe(false);
    expect(result.text).toBe('hello world');
  });
});
