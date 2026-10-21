import { Check } from 'lucide-react'
import { Button, Card, Select } from '@ziee/kit'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldTitle,
} from '@ziee/kit/shadcn/field'
import { ConfigClient } from '@/modules/config-client/ConfigClient.store'
import type { ThemePreference } from '@/modules/config-client/ConfigClient.store'
import {
  ACCENT_PRESETS,
  ACCENT_ORDER,
  type AccentPreset,
} from '@ziee/shell'
import { cn } from '@/lib/utils'

export function ThemeSettings() {
  const { themePreference, accentPreset } = ConfigClient

  const handleChange = (value: string) => {
    ConfigClient.setThemePreference(value as ThemePreference)
  }

  return (
    <Card title="Appearance" data-testid="settingsgen-appearance-card">
      {/* Instant-apply settings (no form state) → the shadcn Field row API:
          label + description on the left, the control on the right. FieldGroup
          supplies the uniform inter-row gap. */}
      <FieldGroup>
        <Field orientation="responsive">
          <FieldContent>
            <FieldTitle>Theme</FieldTitle>
            <FieldDescription>
              Choose your preferred theme or match the OS theme.
            </FieldDescription>
          </FieldContent>
          <Select
            data-testid="settingsgen-theme-select"
            aria-label="Theme"
            className="min-w-[120px]"
            value={themePreference}
            onChange={handleChange}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
              { value: 'system', label: 'System' },
            ]}
          />
        </Field>

        <Field orientation="responsive">
          <FieldContent>
            <FieldTitle>Accent color</FieldTitle>
            <FieldDescription>
              Used for buttons, links, focus rings, and selected items.
            </FieldDescription>
          </FieldContent>
          <div
            className="flex flex-wrap gap-2 items-center justify-end"
            data-testid="settingsgen-accent-picker"
          >
            {ACCENT_ORDER.map(id => {
              const def = ACCENT_PRESETS[id as AccentPreset]
              const selected = accentPreset === id
              return (
                <Button
                  key={id}
                  size="icon"
                  variant="ghost"
                  // A colour swatch shows you the colour and nothing else — which of the nine
                  // it IS has to be said. `tooltip` (not `aria-label`) because the kit adopts a
                  // string tooltip as the accessible name, so the two can never disagree.
                  tooltip={`${def.label} accent`}
                  data-testid={`settingsgen-accent-${id}`}
                  onClick={() =>
                    ConfigClient.setAccentPreset(id as AccentPreset)
                  }
                  // genuinely-dynamic: the swatch shows the preset's own color.
                  data-allow-custom-color
                  style={{ backgroundColor: `hsl(${def.light.primary})` }}
                  className={cn(
                    // inline bg wins over ghost's hover bg, so signal hover via scale instead.
                    'size-7 rounded-full border border-border/40 transition-transform hover:scale-110',
                    selected &&
                      'ring-2 ring-offset-2 ring-offset-background ring-foreground',
                  )}
                >
                  {selected && (
                    <Check className="size-4 text-white" aria-hidden />
                  )}
                </Button>
              )
            })}
          </div>
        </Field>
      </FieldGroup>
    </Card>
  )
}
