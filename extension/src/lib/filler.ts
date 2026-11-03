const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Types text into a (possibly React-controlled) input with realistic events. */
export async function typeInto(input: HTMLInputElement, text: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  input.focus();
  setter.call(input, "");
  let value = "";
  for (const ch of text) {
    value += ch;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
    setter.call(input, value);
    input.dispatchEvent(new InputEvent("input", { data: ch, inputType: "insertText", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
    await sleep(30 + Math.random() * 60);
  }
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

export async function applyVoucher(
  code: HTMLInputElement,
  pin: HTMLInputElement | null,
  apply: HTMLElement | null,
  v: { code: string; pin?: string },
): Promise<void> {
  await typeInto(code, v.code);
  if (pin && v.pin) await typeInto(pin, v.pin);
  await sleep(200);
  if (apply) apply.click();
  else code.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}
