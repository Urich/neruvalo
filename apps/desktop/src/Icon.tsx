import { ReactNode } from "react";
const paths: Record<string, ReactNode> = {
  share: (
    <>
      <circle cx="5" cy="12" r="3" />
      <circle cx="19" cy="5" r="3" />
      <circle cx="19" cy="19" r="3" />
      <path d="m8 11 8-5M8 13l8 5" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7v1" />
    </>
  ),
  login: (
    <>
      <circle cx="8" cy="8" r="5" />
      <path d="m12 12 9 9m-4-4 3-3m-6 0 3-3" />
    </>
  ),
  bank_card: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <rect x="5" y="9" width="5" height="4" rx="1" />
      <path d="M14 15h5" />
    </>
  ),
  note: (
    <>
      <rect x="5" y="2" width="15" height="20" rx="2" />
      <path d="M3 6h4M3 11h4M3 16h4m4-9h6m-6 5h6m-6 5h4" />
    </>
  ),
  bank_account: (
    <>
      <path d="m2 8 10-6 10 6ZM3 21h18M5 10v8m7-8v8m7-8v8" />
    </>
  ),
  api_token: (
    <>
      <path d="M8 3H6v6l-3 3 3 3v6h2m8-18h2v6l3 3-3 3v3" />
      <circle cx="11" cy="11" r="2" />
      <path d="m12.5 12.5 4 4m-1-1 1-1" />
    </>
  ),
  ssh_key: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m6 9 4 3-4 3m7 1h5" />
    </>
  ),
  document: (
    <>
      <path d="M14 2H5v20h14V7Zm0 0v5h5M8 10h6" />
      <circle cx="12" cy="16" r="3" />
      <path d="m10 18-1 3m5-3 1 3" />
    </>
  ),
  crypto_wallet: (
    <>
      <path d="M4 6V4h13v4H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h17V8H4" />
      <path d="M21 12h-7v5h7" />
      <circle cx="16" cy="14.5" r=".5" />
      <circle cx="18" cy="4" r="3" />
    </>
  ),
  settings: (
    <>
      <path d="m9 3-1 3-3 1-2 4 2 3 1 4 4 1 2 2 4-2 3-1 1-4 2-3-2-4-3-1-1-3Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  folder: <path d="M2 6a2 2 0 0 1 2-2h5l3 3h8a2 2 0 0 1 2 2v11H2Z" />,
  archive: (
    <>
      <path d="M3 8h18v13H3ZM2 3h20v5H2Zm7 9h6" />
    </>
  ),
  all: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
};
export function Icon({ name, label }: { name: string; label?: string }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
    >
      {label && <title>{label}</title>}
      {paths[name] ?? paths.document}
    </svg>
  );
}
