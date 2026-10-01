"use client";

import { useRef, useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Searchable username picker. The choice lives in a hidden input so it
 * submits with the surrounding GET form, which is submitted on selection.
 */
export function ContributorSelect({
  name,
  value,
  options,
  className,
  testId,
}: {
  name: string;
  value?: string;
  options: string[];
  className?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function choose(next: string) {
    setOpen(false);
    const input = inputRef.current;
    if (!input) return;
    input.value = next;
    input.form?.requestSubmit();
  }

  return (
    <>
      <input ref={inputRef} type="hidden" name={name} defaultValue={value ?? ""} />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(className, "flex items-center justify-between gap-1 text-left")}
            data-testid={testId}
          >
            <span className={cn("truncate", value ? "font-mono" : "text-muted-foreground")}>
              {value || "Any"}
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-0" align="start">
          <Command>
            <CommandInput placeholder="Search username" />
            <CommandList>
              <CommandEmpty>No contributors found.</CommandEmpty>
              {value ? (
                <CommandItem value="__any__" onSelect={() => choose("")}>
                  Any
                </CommandItem>
              ) : null}
              {options.map((username) => (
                <CommandItem
                  key={username}
                  value={username}
                  data-checked={username === value}
                  onSelect={() => choose(username)}
                  className="font-mono"
                >
                  {username}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </>
  );
}
