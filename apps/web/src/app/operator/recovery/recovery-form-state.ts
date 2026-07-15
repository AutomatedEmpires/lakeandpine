export function resolutionSummaryFieldState(to: string): {
  required: boolean;
  placeholder: string;
} {
  const required = to === "resolved" || to === "closed";
  return {
    required,
    placeholder: required
      ? "Required customer-visible outcome"
      : "Customer-visible outcome when resolving or closing",
  };
}

export function confirmationPreventsSubmission(
  message: string,
  confirm: (prompt: string) => boolean,
): boolean {
  return !confirm(message);
}
