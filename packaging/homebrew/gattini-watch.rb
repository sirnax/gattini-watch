# Template: scripts/render-formula.mjs fills in @URL@ and @SHA256@ from a verified archive.
require "json"

class GattiniWatch < Formula
  desc "Live local dashboard of Claude Code and Codex agents"
  homepage "https://github.com/sirnax/gattini-watch"
  url "@URL@"
  sha256 "@SHA256@"
  license "MIT"

  depends_on "node@24"

  def install
    source = (buildpath/"package/package.json").exist? ? buildpath/"package" : buildpath
    libexec.install source/"package.json", source/"bin", source/"src", source/"public",
                    source/"README.md", source/"LICENSE"
    (bin/"gattini-watch").write <<~SH
      #!/bin/sh
      exec "#{formula_opt_bin("node@24")}/node" "#{libexec}/bin/gattini-watch.mjs" "$@"
    SH
    chmod 0755, bin/"gattini-watch"
  end

  def caveats
    <<~EOS
      Open the dashboard at:
        http://gattini-watch.localhost:4777

      The background service uses port 4777. If that port is taken, run it directly instead:
        gattini-watch --port 4778 --open
    EOS
  end

  service do
    run [opt_bin/"gattini-watch"]
    keep_alive true
    log_path var/"log/gattini-watch.log"
    error_log_path var/"log/gattini-watch.log"
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/gattini-watch --version").strip

    now = Time.now
    claude = testpath/"claude/projects/-work-demo"
    claude.mkpath
    (claude/"session-1.jsonl").write [
      { type: "user", timestamp: now.utc.iso8601, cwd: "/work/demo", entrypoint: "cli",
        message: { role: "user", content: "Say hello" } },
      { type: "assistant", timestamp: now.utc.iso8601, cwd: "/work/demo",
        message: { model: "claude-test", stop_reason: "end_turn", usage: { output_tokens: 1 },
                   content: [{ type: "text", text: "Hello" }] } },
    ].map(&:to_json).join("\n") + "\n"
    codex = testpath/"codex/sessions/#{now.strftime("%Y/%m/%d")}"
    codex.mkpath
    (codex/"rollout-test.jsonl").write [
      { timestamp: now.utc.iso8601, type: "session_meta",
        payload: { id: "test-thread", timestamp: now.utc.iso8601, cwd: "/work/demo",
                   originator: "codex_exec", source: "exec" } },
      { timestamp: now.utc.iso8601, type: "event_msg", payload: { type: "task_started" } },
      { timestamp: now.utc.iso8601, type: "event_msg", payload: { type: "task_complete" } },
    ].map(&:to_json).join("\n") + "\n"

    ENV["CLAUDE_CONFIG_DIR"] = (testpath/"claude").to_s
    ENV["CODEX_HOME"] = (testpath/"codex").to_s
    snapshot = JSON.parse(shell_output("#{bin}/gattini-watch --json --hours 24"))
    assert_equal 1, snapshot.fetch("counts").fetch("claude").fetch("total")
    assert_equal 1, snapshot.fetch("counts").fetch("codex").fetch("total")
    assert_equal 1, snapshot.fetch("audit").fetch("codex").fetch("shown")
  end
end
