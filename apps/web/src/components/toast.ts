"use client";

export function showToast(message: string) {
  window.dispatchEvent(new CustomEvent("lp:toast", { detail: message }));
}
