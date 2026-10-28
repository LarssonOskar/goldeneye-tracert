const OSC = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const CSI = /\x1b\[[0-9;?<]*[A-Za-z~]/g;
const SS3 = /\x1bO[A-Za-z]/g;

/**
 * Removes terminal control sequences from a stdin chunk. Scrolling, arrow
 * keys and mouse-wheel events must never be mistaken for a quit command.
 */
export function stripTerminalSequences(input: string): string {
  return input.replace(OSC, "").replace(CSI, "").replace(SS3, "");
}
