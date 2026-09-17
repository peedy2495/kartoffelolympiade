import { useEffect, useState } from "react";
import { Dialog } from "@base-ui-components/react/dialog";
import { XMarkIcon } from "@heroicons/react/24/outline";
import QRCode from "qrcode";

// QR invitation modal: locally rendered, absolute same-origin link, copy action.
// X sits upper right; Escape + backdrop close natively via Base UI.
export function QrModal({
  open,
  onClose,
  name,
  url,
}: {
  open: boolean;
  onClose: () => void;
  name: string;
  url: string;
}) {
  const [img, setImg] = useState<string>("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open || !url) return;
    setCopied(false);
    let alive = true;
    QRCode.toDataURL(url, { width: 320, margin: 2 })
      .then((d) => {
        if (alive) setImg(d);
      })
      .catch(() => {
        if (alive) setImg("");
      });
    return () => {
      alive = false;
    };
  }, [open, url]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="ko-dialog-backdrop" />
        <Dialog.Popup className="ko-dialog-popup ko-card p-5" aria-label={`Einladung für ${name}`}>
          <div className="flex items-start justify-between gap-3">
            <Dialog.Title className="text-lg font-bold">
              Einladung: {name}
            </Dialog.Title>
            <Dialog.Close className="ko-btn px-3" aria-label="Schließen">
              <XMarkIcon className="h-5 w-5" aria-hidden="true" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="ko-hint mt-1">
            QR-Code scannen oder Link kopieren — Zugang für diese Aufsicht.
          </Dialog.Description>
          <div className="mt-4 flex justify-center">
            {img ? (
              <img src={img} alt={`QR-Code Einladung ${name}`} width={240} height={240} />
            ) : (
              <p className="ko-hint">QR-Code wird erzeugt …</p>
            )}
          </div>
          <p className="ko-soft mt-3 break-all p-3 text-sm">{url}</p>
          <div className="mt-4 flex gap-2">
            <button type="button" className="ko-btn ko-btn-primary flex-1" onClick={copy}>
              {copied ? "Kopiert!" : "Link kopieren"}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
