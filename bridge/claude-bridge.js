const http = require("http");
const { execFile } = require("child_process");

const PORT = 3000;
const CLAUDE_BIN = "claude";

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => resolve(body));
  });
}

function runClaudePrompt(prompt) {
  return new Promise((resolve, reject) => {
    execFile(
      CLAUDE_BIN,
      ["-p", prompt],
      {
        timeout: 120000,
        maxBuffer: 1024 * 1024 * 10
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }

        resolve(stdout.trim());
      }
    );
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  if (req.method === "GET") {
    res.end(JSON.stringify({
      ok: true,
      bridge: "claude-code-cli",
      mode: "claude -p"
    }));
    return;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
    const raw = await readBody(req);
    const data = JSON.parse(raw || "{}");

    const prompt =
      data.prompt ||
      data.message ||
      data.input ||
      JSON.stringify(data);

    const output = await runClaudePrompt(prompt);

    res.end(JSON.stringify({
      ok: true,
      text: output,
      response: output,
      actions: []
    }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({
      ok: false,
      error: String(err.message || err)
    }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Claude Code bridge running on http://localhost:" + PORT);
  console.log("Mode: claude -p");
});