import type { ResumeSlotIndex } from "./types";
import { SLOT_LABELS } from "./types";

export function resumeTypeToSlotIndex(resumeType: 1 | 2 | 3 | 4): ResumeSlotIndex {
  const index = resumeType - 1;
  if (index < 0 || index > 3) {
    throw new Error(`Invalid resume type: ${resumeType}`);
  }
  return index as ResumeSlotIndex;
}

export function slotLabel(slotIndex: ResumeSlotIndex): string {
  return SLOT_LABELS[slotIndex] ?? `Slot ${slotIndex + 1}`;
}
