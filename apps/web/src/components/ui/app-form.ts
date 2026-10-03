export function createSubmitEvent(valid: boolean) {
  const event = new Event('submit', { cancelable: true });
  Object.defineProperty(event, 'valid', { value: valid, enumerable: true });
  return event as SubmitEvent & { valid: boolean };
}
