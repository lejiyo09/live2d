/**
 * Open the browser file picker. The input is attached to the document so it
 * cannot be garbage-collected before the user picks; leftovers from earlier
 * (cancelled) pickers are removed when a new one opens. It is deliberately
 * not removed on `cancel`: browsers may fire `cancel` before a late `change`.
 */
export function openFilePicker(opts: { accept: string; multiple?: boolean }, cb: (files: FileList) => void) {
  document.querySelectorAll('input[data-l2s-picker]').forEach((el) => el.remove());
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = opts.accept;
  input.multiple = !!opts.multiple;
  input.hidden = true;
  input.dataset.l2sPicker = '';
  document.body.appendChild(input);
  input.addEventListener('change', () => {
    if (input.files?.length) cb(input.files);
    input.remove();
  });
  input.click();
}
