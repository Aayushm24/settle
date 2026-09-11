export interface DocumentExtractionResult {
  text: string;
  usedOcr: boolean;
  warning: string | null;
}

interface PromiseWithResolvers<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function isImage(file: File): boolean {
  return file.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(file.name);
}

function isPdf(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

async function recognizeImage(image: File | HTMLCanvasElement): Promise<string> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng");
  try {
    const result = await worker.recognize(image);
    return result.data.text.trim();
  } finally {
    await worker.terminate();
  }
}

function ensurePromiseWithResolversPolyfill(): void {
  const constructor = Promise as PromiseConstructor;
  if (typeof constructor.withResolvers === "function") {
    return;
  }

  constructor.withResolvers = function withResolvers<T>(): PromiseWithResolvers<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((innerResolve, innerReject) => {
      resolve = innerResolve;
      reject = innerReject;
    });
    return { promise, resolve, reject };
  };
}

async function extractPdf(file: File): Promise<DocumentExtractionResult> {
  ensurePromiseWithResolversPolyfill();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/legacy/build/pdf.worker.mjs",
    import.meta.url,
  ).toString();

  const loadingTask = pdfjs.getDocument({ data: await file.arrayBuffer() });
  let pdf: Awaited<typeof loadingTask.promise> | null = null;
  const pageTexts: string[] = [];
  let usedOcr = false;

  try {
    pdf = await loadingTask.promise;

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        let pageText = "";

        for (const item of content.items) {
          if (!("str" in item)) {
            continue;
          }
          pageText += item.str;
          pageText += item.hasEOL ? "\n" : " ";
        }
        pageText = pageText.replaceAll(/[ \t]+\n/g, "\n").replaceAll(/[ \t]{2,}/g, " ").trim();

        if (pageText.replaceAll(/\s/g, "").length < 20) {
          const viewport = page.getViewport({ scale: 2 });
          const canvas = document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const context = canvas.getContext("2d");
          if (!context) {
            throw new Error(`Could not prepare page ${pageNumber} for OCR.`);
          }
          const renderTask = page.render({ canvas, canvasContext: context, viewport });
          await renderTask.promise;
          pageText = await recognizeImage(canvas);
          usedOcr = true;
          canvas.width = 0;
          canvas.height = 0;
        }

        pageTexts.push(pageText);
      } finally {
        page.cleanup();
      }
    }

    const text = pageTexts.filter(Boolean).join("\n");
    return { text, usedOcr, warning: text ? null : "No readable text was found in this PDF." };
  } finally {
    if (pdf) {
      pdf.cleanup();
      await loadingTask.destroy();
    } else {
      await loadingTask.destroy();
    }
  }
}

export async function extractDocumentText(file: File): Promise<DocumentExtractionResult> {
  if (isPdf(file)) return extractPdf(file);
  if (isImage(file)) {
    const text = await recognizeImage(file);
    return { text, usedOcr: true, warning: text ? null : "OCR could not find readable text in this image." };
  }
  const text = await file.text();
  return { text, usedOcr: false, warning: text ? null : "This file is empty." };
}
