export function getEditKey(messageId: string, editIndex: number): string {
  return `${messageId}:edit-${editIndex}`;
}

export function parseEditKey(
  key: string,
): { messageId: string; blockIndex: number } | null {
  const marker = ":edit-";
  const markerIndex = key.lastIndexOf(marker);
  if (markerIndex <= 0) return null;
  const blockIndexText = key.slice(markerIndex + marker.length);
  if (!/^(0|[1-9]\d*)$/.test(blockIndexText)) return null;
  return {
    messageId: key.slice(0, markerIndex),
    blockIndex: Number(blockIndexText),
  };
}
