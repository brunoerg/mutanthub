import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  eyebrow?: React.ReactNode;
}

export function PageHeader({ title, description, actions, className, eyebrow }: PageHeaderProps) {
  return (
    <div
      className={cn("flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between", className)}
    >
      <div className="min-w-0">
        {eyebrow ? <div className="text-muted-foreground mb-1 text-xs">{eyebrow}</div> : null}
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="text-muted-foreground mt-1 max-w-2xl text-sm">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function PageContainer({
  children,
  className,
  wide,
}: {
  children: React.ReactNode;
  className?: string;
  wide?: boolean;
}) {
  return (
    <main
      className={cn(
        "mx-auto w-full px-4 py-6 sm:px-6",
        wide ? "max-w-[1600px]" : "max-w-6xl",
        className,
      )}
    >
      {children}
    </main>
  );
}
