import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const cliPath = process.env.SIGNAL_CLI_PATH ?? "signal-cli";
const phone = process.env.SIGNAL_ACCOUNT_PHONE ?? "";
const groupId = process.env.SIGNAL_GROUP_ID ?? "";

export async function sendSignalMessage(message: string): Promise<void> {
  if (!phone || !groupId) {
    throw new Error("SIGNAL_ACCOUNT_PHONE and SIGNAL_GROUP_ID must be set");
  }
  await execFileAsync(cliPath, ["-a", phone, "send", "-g", groupId, "-m", message]);
}
