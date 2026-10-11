export const config = {
  api: {
    bodyParser: false,
    sizeLimit: "30mb"
  }
};

const MAX_FILE_SIZE = 25 * 1024 * 1024;

const ALLOWED_EXTENSIONS = new Set([
  ".mp3",
  ".mp4",
  ".mpeg",
  ".mpga",
  ".m4a",
  ".wav",
  ".webm",
  ".ogg",
  ".flac"
]);

function sendJson(res, status, data) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function readRequest(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", chunk => {
      size += chunk.length;

      if (size > MAX_FILE_SIZE + 1024 * 1024) {
        const error = new Error("The upload is too large. Please use a file under 25 MB.");
        error.statusCode = 413;
        reject(error);

        if (typeof req.destroy === "function") {
          req.destroy();
        }
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    req.on("error", reject);
  });
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);

  if (!boundaryMatch) {
    throw new Error("Invalid multipart upload.");
  }

  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const body = buffer.toString("latin1");
  const delimiter = "--" + boundary;
  const parts = body.split(delimiter);

  const result = {};

  for (let part of parts) {
    if (!part || part === "--\r\n" || part === "--") continue;

    if (part.startsWith("\r\n")) {
      part = part.slice(2);
    }

    const separator = part.indexOf("\r\n\r\n");
    if (separator < 0) continue;

    const headerText = part.slice(0, separator);
    let content = part.slice(separator + 4);

    if (content.endsWith("\r\n")) {
      content = content.slice(0, -2);
    }

    if (content.endsWith("--")) {
      content = content.slice(0, -2);
    }

    const disposition = headerText.match(
      /content-disposition:\s*form-data;[^\r\n]*/i
    );

    if (!disposition) continue;

    const nameMatch = disposition[0].match(/name="([^"]+)"/i);
    if (!nameMatch) continue;

    const name = nameMatch[1];
    const filenameMatch = disposition[0].match(/filename="([^"]*)"/i);

    if (filenameMatch) {
      const typeMatch = headerText.match(/content-type:\s*([^\r\n]+)/i);

      result[name] = {
        filename: filenameMatch[1],
        contentType: typeMatch ? typeMatch[1].trim() : "application/octet-stream",
        data: Buffer.from(content, "latin1")
      };
    } else {
      result[name] = Buffer.from(content, "latin1").toString("utf8");
    }
  }

  return result;
}

function extensionOf(filename) {
  const index = filename.lastIndexOf(".");
  return index >= 0 ? filename.slice(index).toLowerCase() : "";
}

function normalizeSegments(data) {
  if (Array.isArray(data.segments)) {
    return data.segments.map(segment => ({
      start: Number(segment.start ?? 0),
      end: Number(segment.end ?? segment.start ?? 0),
      text: String(segment.text ?? "").trim()
    })).filter(segment => segment.text);
  }

  // Some responses may provide words rather than sentence segments.
  if (Array.isArray(data.words)) {
    return data.words.map(word => ({
      start: Number(word.start ?? 0),
      end: Number(word.end ?? word.start ?? 0),
      text: String(word.word ?? word.text ?? "").trim()
    })).filter(segment => segment.text);
  }

  return [];
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { error: "Method not allowed. Use POST." });
  }

  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return sendJson(res, 500, {
      error: "The server is missing its OPENAI_API_KEY environment variable."
    });
  }

  const contentType = req.headers["content-type"] || "";

  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return sendJson(res, 400, {
      error: "Please upload an audio file using the upload form."
    });
  }

  try {
    const rawBody = await readRequest(req);
    const form = parseMultipart(rawBody, contentType);

    const file = form.file;

    if (!file || !file.data || !file.filename) {
      return sendJson(res, 400, {
        error: "No audio file was received."
      });
    }

    if (!file.data.length) {
      return sendJson(res, 400, {
        error: "The selected audio file is empty."
      });
    }

    if (file.data.length > MAX_FILE_SIZE) {
      return sendJson(res, 413, {
        error: "The file exceeds the 25 MB upload limit."
      });
    }

    const extension = extensionOf(file.filename);

    if (!ALLOWED_EXTENSIONS.has(extension)) {
      return sendJson(res, 400, {
        error: "Unsupported file extension. Please upload MP3, WAV, M4A, MP4, WEBM, OGG, FLAC, or MPEG audio."
      });
    }

    const language = String(form.language || "auto");
    const context = String(form.context || "").trim().slice(0, 500);
    const wantTimestamps = String(form.timestamps || "true") === "true";

    const upload = new FormData();

    upload.append(
      "file",
      new Blob([file.data], {
        type: file.contentType || "application/octet-stream"
      }),
      file.filename
    );

    /*
      gpt-4o-transcribe is used for the primary transcript.
      For word-level timestamps, use whisper-1, which supports
      verbose_json and timestamp_granularities.
    */

    const model = wantTimestamps ? "whisper-1" : "gpt-4o-transcribe";

    upload.append("model", model);

    if (language !== "auto") {
      upload.append("language", language);
    }

    if (context) {
      upload.append("prompt", context);
    }

    if (wantTimestamps) {
      upload.append("response_format", "verbose_json");
      upload.append("timestamp_granularities[]", "segment");
      upload.append("timestamp_granularities[]", "word");
    } else {
      upload.append("response_format", "json");
    }

    const upstream = await fetch(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`
        },
        body: upload
      }
    );

    const responseText = await upstream.text();

    let result;

    try {
      result = JSON.parse(responseText);
    } catch {
      result = { error: { message: responseText || "Invalid transcription response." } };
    }

    if (!upstream.ok) {
      const message =
        result?.error?.message ||
        "The transcription service could not process this audio.";

      const status = upstream.status === 429 ? 429 :
        upstream.status >= 500 ? 502 : 400;

      return sendJson(res, status, {
        error: message
      });
    }

    const text = typeof result.text === "string" ? result.text : "";

    return sendJson(res, 200, {
      text,
      language: result.language || language,
      duration: result.duration || null,
      segments: wantTimestamps ? normalizeSegments(result) : [],
      model
    });

  } catch (error) {
    console.error("Transcription error:", error);

    if (res.writableEnded) return;

    const status = error.statusCode || 500;

    return sendJson(res, status, {
      error: error.message || "An unexpected server error occurred."
    });
  }
}
