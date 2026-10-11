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

  // Strip invisible/non-ASCII characters (e.g. U+200E, code 8206) that can
  // sneak in when the key is copy-pasted. HTTP headers only allow plain ASCII.
  const apiKey = (process.env.OPENAI_API_KEY || "")
    .replace(/[^\x20-\x7E]/g, "")
    .trim();

  if (!apiKey) {
    return sendJson(res, 500, {
      error: "The server is missing its OPENAI_API_KEY environment variable."
    });
  }

  const contentType = req.headers["content-type"] || "";

  if (!contentType.toL
