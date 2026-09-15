export function isRmRfCommand(cmd: string): boolean {
  const low = cmd.toLowerCase();
  if (!/\brm\b/.test(low)) return false;
  // --recursive + --force
  if (low.includes("--recursive") && low.includes("--force")) return true;
  // detect -rf / -fr / split -r -f : look for separate flags containing r and f
  const tokens = low.split(/\s+/);
  const flags = tokens.filter(t => t.startsWith("-") && !t.startsWith("--"));
  const hasR = flags.some(f => f.includes("r"));
  const hasF = flags.some(f => f.includes("f"));
  if (hasR && hasF) return true;
  // fallback single-token combined check (covers -rf, -fr, -Rrf, etc.)
  return /\s-[a-z]*r[a-z]*f/.test(low) || /\s-[a-z]*f[a-z]*r/.test(low);
}

export function isBashLogicalFail(
  output: string,
  isError: boolean,
  toolName: string,
): boolean {
  return (
    toolName === "bash" &&
    !isError &&
    output.length > 20 &&
    /\b(fail(ed)?|error|exception|ENOENT|not found|cannot|unable)\b/i.test(
      output,
    ) &&
    !/\b(passed|success|ok\b)/i.test(output)
  );
}
