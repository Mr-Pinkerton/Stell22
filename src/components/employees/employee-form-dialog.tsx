"use client";

import { useState } from "react";
import { XIcon } from "lucide-react";
import { capitalizeFirst, cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { FormSubmitButton } from "@/components/form-dialog-shared";
import { fieldInvalidClass } from "@/components/nomenclature/form-shared";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import type { Employee } from "@/types/domain";
import type { EmployeeFormValues } from "@/server/employees";

const fieldClass =
  "border-border bg-card hover:border-[#98a2b3] focus-visible:border-ring focus-visible:bg-card h-10 rounded-xl border px-4";

const narrowFieldClass = cn(fieldClass, "w-full sm:max-w-none");

interface EmployeeFormDialogProps {
  open: boolean;
  employee?: Employee | null;
  onOpenChange: (open: boolean) => void;
  onSubmit?: (values: EmployeeFormValues) => void | Promise<void>;
  pending?: boolean;
}

/** DD.MM.YYYY → ISO yyyy-mm-dd (null, если не полная дата). */
function displayDateToIso(display: string): string | null {
  const digits = display.replace(/\D/g, "");
  if (digits.length !== 8) return null;
  const dd = digits.slice(0, 2);
  const mm = digits.slice(2, 4);
  const yyyy = digits.slice(4, 8);
  return `${yyyy}-${mm}-${dd}`;
}

function FormSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Field({
  id,
  label,
  required,
  invalid,
  className,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  invalid?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("grid gap-1.5", invalid && fieldInvalidClass, className)}>
      <Label htmlFor={id}>
        {label}
        {required && <span className="text-destructive"> *</span>}
      </Label>
      {children}
    </div>
  );
}

function isoToDisplayDate(iso?: string | null): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return "";
  return `${d.padStart(2, "0")}.${m.padStart(2, "0")}.${y}`;
}

/** DD.MM.YYYY по мере ввода цифр. */
function formatBirthDateInput(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}.${digits.slice(2)}`;
  return `${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4)}`;
}

/** Форма добавления/редактирования сотрудника. */
export function EmployeeFormDialog({
  open,
  employee,
  onOpenChange,
  onSubmit,
  pending,
}: EmployeeFormDialogProps) {
  const isEdit = Boolean(employee);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-xl" showCloseButton={false}>
        {open ? (
          <EmployeeFormBody
            isEdit={isEdit}
            employee={employee}
            pending={pending}
            onOpenChange={onOpenChange}
            onSubmit={onSubmit}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function EmployeeFormBody({
  isEdit,
  employee,
  pending,
  onOpenChange,
  onSubmit,
}: {
  isEdit: boolean;
  employee?: Employee | null;
  pending?: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit?: (values: EmployeeFormValues) => void | Promise<void>;
}) {
  const [fullName, setFullName] = useState(employee?.fullName ?? "");
  const [birth, setBirth] = useState(() => isoToDisplayDate(employee?.birthDate));
  const [pin, setPin] = useState(employee?.pin ?? "");
  const [hourlyRate, setHourlyRate] = useState<number | null>(employee?.hourlyRate ?? null);
  const [rateT1, setRateT1] = useState<number | null>(employee?.rateTorcovkaSort1 ?? null);
  const [rateT2, setRateT2] = useState<number | null>(employee?.rateTorcovkaSort2 ?? null);
  const [ratePrisadka, setRatePrisadka] = useState<number | null>(
    employee?.ratePrisadkaTorcev ?? employee?.ratePrisadkaPloskt ?? null,
  );
  const [rateUp, setRateUp] = useState<number | null>(employee?.rateUpakovka ?? null);
  const [showErrors, setShowErrors] = useState(false);

  const canSubmit = fullName.trim().length > 0 && !pending;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    await onSubmit?.({
      fullName,
      birthDate: displayDateToIso(birth),
      pin,
      hourlyRate,
      rateTorcovkaSort1: rateT1,
      rateTorcovkaSort2: rateT2,
      ratePrisadka,
      rateUpakovka: rateUp,
    });
  };

  return (
    <>
        <div className="border-border flex items-center gap-4 border-b px-6 py-4">
          <DialogTitle className="min-w-0 flex-1 text-lg leading-tight font-semibold">
            {isEdit ? "Изменить сотрудника" : "Добавить сотрудника"}
          </DialogTitle>
          <DialogClose
            render={
              <Button
                type="button"
                variant="ghost"
                className="icon-action-btn size-[2.4rem] shrink-0 rounded-xl"
                aria-label="Закрыть"
              />
            }
          >
            <XIcon className="size-[1.4rem]" />
          </DialogClose>
        </div>

        <div className="scrollbar-thin-y max-h-[min(70vh,32rem)] space-y-5 overflow-y-auto px-6 py-6">
          <FormSection title="Основная информация">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
              <Field
                id="emp-name"
                label="ФИО"
                required
                invalid={showErrors && !fullName.trim()}
                className="min-w-0 flex-1"
              >
                <Input
                  id="emp-name"
                  className={fieldClass}
                  autoCapitalize="words"
                  placeholder="Иванов Иван Иванович"
                  value={fullName}
                  onChange={(e) => setFullName(capitalizeFirst(e.target.value))}
                />
              </Field>
              <Field id="emp-birth" label="Дата рождения" className="w-full shrink-0 sm:w-36">
                <Input
                  id="emp-birth"
                  type="text"
                  inputMode="numeric"
                  className={cn(fieldClass, "tabular-nums")}
                  placeholder="ДД.ММ.ГГГГ"
                  maxLength={10}
                  value={birth}
                  onChange={(e) => setBirth(formatBirthDateInput(e.target.value))}
                />
              </Field>
            </div>
          </FormSection>

          <Separator />

          <FormSection title="Доступ">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="emp-pin" label="PIN-код">
                <Input
                  id="emp-pin"
                  className={narrowFieldClass}
                  placeholder="4 цифры"
                  maxLength={4}
                  inputMode="numeric"
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                />
              </Field>
            </div>
          </FormSection>

          <Separator />

          <FormSection title="Оплата">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="emp-hourly" label="Почасовая — ставка в час">
                <MoneyInput
                  id="emp-hourly"
                  className={narrowFieldClass}
                  suffix="₽/ч"
                  value={hourlyRate}
                  onValueChange={setHourlyRate}
                />
              </Field>
            </div>
            <p className="text-muted-foreground -mt-1 text-xs leading-relaxed">
              Сдельная оплата за производственные операции. Если сдельные расценки не указаны —
              работник на окладе (оплата только за часы).
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="emp-t1" label="Торцовка 1 сорт">
                <MoneyInput
                  id="emp-t1"
                  className={narrowFieldClass}
                  suffix="₽/деталь"
                  value={rateT1}
                  onValueChange={setRateT1}
                />
              </Field>
              <Field id="emp-t2" label="Торцовка 2 сорт">
                <MoneyInput
                  id="emp-t2"
                  className={narrowFieldClass}
                  suffix="₽/деталь"
                  value={rateT2}
                  onValueChange={setRateT2}
                />
              </Field>
              <Field id="emp-prisadka" label="Присадка">
                <MoneyInput
                  id="emp-prisadka"
                  className={narrowFieldClass}
                  suffix="₽/присадка"
                  value={ratePrisadka}
                  onValueChange={setRatePrisadka}
                />
              </Field>
              <Field id="emp-up" label="Упаковка">
                <MoneyInput
                  id="emp-up"
                  className={narrowFieldClass}
                  suffix="₽/изделие"
                  value={rateUp}
                  onValueChange={setRateUp}
                />
              </Field>
            </div>
          </FormSection>
        </div>

        <DialogFooter className="bg-muted/50 border-border !m-0 gap-2 border-t px-6 py-4 sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            className="h-10 rounded-xl px-5"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Отмена
          </Button>
          <FormSubmitButton
            className="h-10 rounded-xl px-5"
            canSubmit={canSubmit}
            pending={pending}
            onInvalid={() => setShowErrors(true)}
            onSubmit={handleSubmit}
          >
            {isEdit ? "Сохранить" : "Создать сотрудника"}
          </FormSubmitButton>
        </DialogFooter>
    </>
  );
}
