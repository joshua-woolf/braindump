import { useEffect, type ReactNode } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { ThemeProvider, useTheme } from "next-themes";
import { Button } from "@/components/ui/button";

export function AppearanceProvider({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      storageKey="braindump.theme"
      value={{ light: "light", dark: "dark" }}
      enableSystem
      disableTransitionOnChange
      scriptProps={{ src: "/theme.js" }}
    >
      {children}
    </ThemeProvider>
  );
}

export function ThemeToggle() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const label = dark ? "Switch to Light Mode" : "Switch to Dark Mode";

  useEffect(() => {
    if (theme && !["light", "dark", "system"].includes(theme)) {
      setTheme("system");
    }
  }, [theme, setTheme]);

  return (
    <Button
      variant="ghost"
      size="icon"
      className="text-muted-foreground"
      aria-label={label}
      title={label}
      onClick={() => setTheme(dark ? "light" : "dark")}
    >
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}

export function AppearanceSettings() {
  const { theme, setTheme } = useTheme();
  return (
    <section className="panel">
      <div className="mb-5 flex items-center gap-3">
        <Monitor className="text-primary" size={21} />
        <h2 className="font-semibold">Appearance</h2>
      </div>
      <label className="field-label" htmlFor="appearance-theme">
        Color Theme
      </label>
      <select
        id="appearance-theme"
        className="filter-select w-full sm:w-56"
        value={theme || "system"}
        onChange={(event) => setTheme(event.target.value)}
        aria-describedby="appearance-description"
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
      <p
        id="appearance-description"
        className="mt-3 text-sm leading-6 text-muted-foreground"
      >
        System follows your device’s appearance. Changes apply immediately and
        are remembered in this browser.
      </p>
    </section>
  );
}
