import type { SVGProps } from 'react'

export type IconName =
  | 'folder'
  | 'file'
  | 'play'
  | 'refresh'
  | 'settings'
  | 'plus'
  | 'send'
  | 'stop'
  | 'x'
  | 'chevron'
  | 'terminal'
  | 'download'
  | 'warning'
  | 'check'
  | 'clock'
  | 'trash'
  | 'edit'
  | 'external'
  | 'sidebar'
  | 'spark'
  | 'agent'
  | 'preview'
  | 'book'
  | 'more'

const PATHS: Record<IconName, string[]> = {
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z'],
  file: ['M6 2h8l4 4v16H6V2Z', 'M14 2v5h5'],
  play: ['M7 4l13 8-13 8V4Z'],
  refresh: ['M20 11a8 8 0 1 0-2.3 6.3', 'M20 4v7h-7'],
  settings: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  ],
  plus: ['M12 5v14', 'M5 12h14'],
  send: ['M22 2 11 13', 'M22 2 15 22l-4-9-9-4 20-7Z'],
  stop: ['M7 7h10v10H7z'],
  x: ['M6 6l12 12', 'M18 6 6 18'],
  chevron: ['M9 6l6 6-6 6'],
  terminal: ['M4 5h16v14H4z', 'M8 9l3 3-3 3', 'M13 15h4'],
  download: ['M12 3v12', 'M7 10l5 5 5-5', 'M4 21h16'],
  warning: ['M12 3 2 21h20L12 3Z', 'M12 9v5', 'M12 18h.01'],
  check: ['M4 12l5 5L20 6'],
  clock: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', 'M12 6v6l4 2'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 14h10l1-14'],
  edit: ['M4 20h4L20 8l-4-4L4 16v4Z', 'M14 6l4 4'],
  external: ['M14 3h7v7', 'M10 14 21 3', 'M21 14v7H3V3h7'],
  sidebar: ['M4 4h16v16H4z', 'M9 4v16'],
  spark: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z'],
  agent: ['M4 5h16v11H8l-4 4V5Z', 'M8 9h8', 'M8 12h5'],
  preview: ['M3 4h18v16H3z', 'M3 9h18', 'M7 6.5h.01', 'M10 6.5h.01'],
  book: ['M4 4h7a3 3 0 0 1 3 3v13a3 3 0 0 0-3-3H4V4Z', 'M20 4h-3a3 3 0 0 0-3 3v13a3 3 0 0 1 3-3h3V4Z'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
}

export function Icon({
  name,
  size = 16,
  ...props
}: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {PATHS[name].map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  )
}
