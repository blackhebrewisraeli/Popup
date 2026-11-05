import { cn } from '@/lib/utils';

export function PopupMark({ className }: Readonly<{ className?: string }>) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M5 21V9a6 6 0 0 1 6-6h4a5 5 0 0 1 0 10H9v4a4 4 0 0 1-4 4Zm4-12v.5h6a1.5 1.5 0 0 0 0-3h-4a2 2 0 0 0-2 2V9Z"
      />
    </svg>
  );
}

export function BrandLogo({
  className,
  uppercase = false,
  markClassName,
}: Readonly<{
  className?: string;
  uppercase?: boolean;
  markClassName?: string;
}>) {
  return (
    <span className={cn('brand-lockup', className)}>
      <span className={cn('brand-mark', markClassName)}>
        <PopupMark />
      </span>
      <span className={cn('brand-wordmark font-semibold', uppercase && 'brand-wordmark-uppercase')}>
        {uppercase ? 'POPUP' : 'popup'}
        <span className="text-primary">.</span>
      </span>
    </span>
  );
}
