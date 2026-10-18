"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, CalendarClock, Check, FileSpreadsheet, Loader2, Rocket, Save, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { RecipientsInput, recipientStats } from "@/components/messaging/recipients-input";
import { SenderInput, useSenderIds } from "@/components/messaging/sender-input";
import { SmsCounter } from "@/components/messaging/sms-counter";
import { Money } from "@/components/shared/money";
import { PageHeader } from "@/components/shared/page-header";
import { useDebouncedValue } from "@/hooks/use-debounce";
import { api, errorMessage, qk } from "@/lib/api";
import type { Campaign } from "@/lib/api/types";
import { useSession } from "@/lib/auth/session";
import { type ParsedCsv, findPhoneColumn, parseCsv, toCsv } from "@/lib/csv";
import { readFileText } from "@/lib/download";
import { formatNumber } from "@/lib/format";
import { normalizeMsisdn, isValidSender } from "@/lib/phone";
import { estimateCost } from "@/lib/rates";
import { MAX_PARTS, analyzeSms } from "@/lib/sms";
import { findPlaceholders, insertAt, missingPlaceholders, normalizeColumn, renderTemplate } from "@/lib/template-vars";
import { cn } from "@/lib/utils";

/** api limits (CONTRACTS-CHANGES api part 2 #11) */
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_RECIPIENTS = 100_000;
/** pasted lists above this go up as a CSV file (JSON bodies are capped at 2 MB) */
const JSON_MAX_RECIPIENTS = 20_000;
/** rows analysed for per-recipient parts/cost (keeps typing responsive on huge files) */
const ANALYSE_ROWS = 5000;

type Source = "csv" | "paste";
type When = "now" | "schedule" | "draft";

interface Recipient {
  phone: string;
  vars: Record<string, string>;
}

const STEPS = ["Recipients", "Message", "Schedule & review"] as const;

function localDateTimeValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function CampaignWizard() {
  const router = useRouter();
  const { org } = useSession();
  const [step, setStep] = useState(0);
  const [source, setSource] = useState<Source>("csv");

  // CSV state
  const [file, setFile] = useState<File | null>(null);
  const [csv, setCsv] = useState<ParsedCsv | null>(null);
  const [phoneCol, setPhoneCol] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // paste state
  const [pasted, setPasted] = useState("");
  const pastedDebounced = useDebouncedValue(pasted, 150);
  const pasteStats = useMemo(() => recipientStats(pastedDebounced), [pastedDebounced]);

  // message state
  const [name, setName] = useState("");
  const [sender, setSender] = useState("");
  const [body, setBody] = useState("");
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // schedule state
  const [when, setWhen] = useState<When>("now");
  const [scheduledAt, setScheduledAt] = useState(() => localDateTimeValue(new Date(Date.now() + 60 * 60_000)));
  const [submitting, setSubmitting] = useState(false);

  const senders = useSenderIds();
  const balance = useQuery({
    queryKey: qk.orgs.balance(org.id),
    queryFn: () => api.orgs.balance(org.id),
    staleTime: 30_000,
    retry: false,
  });
  const rates = useQuery({
    queryKey: qk.orgs.routes(org.id),
    queryFn: () => api.orgs.routes(org.id),
    staleTime: 60_000,
    retry: false,
  });
  const currency = balance.data?.currency ?? "USD";

  // Default to the first approved sender once known.
  useEffect(() => {
    if (!sender && senders.approved.length > 0) setSender(senders.approved[0].sender);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [senders.approved.length]);

  /* ---------------------------------------------------------- recipients */

  const loadFile = async (f: File) => {
    setFileError(null);
    if (f.size > MAX_FILE_BYTES) {
      setFileError(`File is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
      return;
    }
    setParsing(true);
    try {
      const text = await readFileText(f);
      const parsed = parseCsv(text);
      if (parsed.headers.length === 0 || parsed.rows.length === 0) {
        setFileError("The file has no data rows. The first line must be a header, e.g. phone,name");
        return;
      }
      setFile(f);
      setCsv(parsed);
      setPhoneCol(findPhoneColumn(parsed.headers));
    } catch (e) {
      setFileError(errorMessage(e));
    } finally {
      setParsing(false);
    }
  };

  const csvRecipients = useMemo(() => {
    if (!csv || !phoneCol) return null;
    const pi = csv.headers.indexOf(phoneCol);
    const valid: Recipient[] = [];
    const invalid: string[] = [];
    const seen = new Set<string>();
    let duplicates = 0;
    for (const row of csv.rows) {
      const raw = (row[pi] ?? "").trim();
      const phone = normalizeMsisdn(raw);
      if (!phone) {
        invalid.push(raw || "(empty)");
        continue;
      }
      if (seen.has(phone)) duplicates += 1;
      seen.add(phone);
      if (valid.length < ANALYSE_ROWS) {
        const vars: Record<string, string> = {};
        csv.headers.forEach((h, i) => {
          const name = normalizeColumn(h);
          if (i !== pi && name) vars[name] = (row[i] ?? "").trim();
        });
        valid.push({ phone, vars });
      }
    }
    const total = csv.rows.length - invalid.length;
    return { sample: valid, total, invalid, duplicates };
  }, [csv, phoneCol]);

  const recipientCount = source === "csv" ? (csvRecipients?.total ?? 0) : pasteStats.valid.length;
  const sample: Recipient[] = useMemo(
    () =>
      source === "csv"
        ? (csvRecipients?.sample ?? [])
        : pasteStats.valid.slice(0, ANALYSE_ROWS).map((phone) => ({ phone, vars: {} })),
    [source, csvRecipients, pasteStats.valid],
  );
  /** placeholder names: every non-phone CSV column, normalized like the api */
  const columns = useMemo(
    () =>
      source === "csv" && csv
        ? csv.headers.filter((h) => h !== phoneCol).map(normalizeColumn).filter((n) => n && n !== "phone")
        : [],
    [source, csv, phoneCol],
  );
  const duplicateColumn = useMemo(() => {
    if (!csv) return null;
    const names = csv.headers.map((h) => (h === phoneCol ? "phone" : normalizeColumn(h) === "phone" ? `${normalizeColumn(h)}_original` : normalizeColumn(h)));
    return names.find((n, i) => n && names.indexOf(n) !== i) ?? null;
  }, [csv, phoneCol]);

  /* ------------------------------------------------------------- message */

  const insertPlaceholder = (col: string) => {
    const el = bodyRef.current;
    const res = insertAt(body, `{${col}}`, el?.selectionStart, el?.selectionEnd);
    setBody(res.text);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(res.caret, res.caret);
    });
  };

  const debouncedBody = useDebouncedValue(body, 200);
  const placeholders = useMemo(() => findPlaceholders(debouncedBody), [debouncedBody]);
  const missing = useMemo(() => missingPlaceholders(debouncedBody, columns), [debouncedBody, columns]);
  const rendered = useMemo(() => {
    if (!debouncedBody) return null;
    let maxParts = 0;
    let tooLong = 0;
    let ucs2 = 0;
    const partsByPhone: Array<{ phone: string; parts: number }> = [];
    for (const r of sample) {
      const a = analyzeSms(renderTemplate(debouncedBody, r.vars));
      maxParts = Math.max(maxParts, a.parts);
      if (a.tooLong) tooLong += 1;
      if (a.encoding === "UCS2") ucs2 += 1;
      partsByPhone.push({ phone: r.phone, parts: a.parts });
    }
    return { maxParts, tooLong, ucs2, partsByPhone };
  }, [debouncedBody, sample]);

  const estimate = useMemo(() => {
    if (!rates.data || !rendered || rendered.partsByPhone.length === 0) return null;
    let total = 0;
    let unpriced = 0;
    for (const p of rendered.partsByPhone) {
      const e = estimateCost(rates.data, [p.phone], p.parts);
      total += e.total_micros;
      unpriced += e.unpriced.length;
    }
    // extrapolate when only a sample was analysed
    const factor = recipientCount > rendered.partsByPhone.length ? recipientCount / rendered.partsByPhone.length : 1;
    return { total: Math.round(total * factor), unpriced, extrapolated: factor > 1 };
  }, [rates.data, rendered, recipientCount]);

  /* ---------------------------------------------------------- validation */

  const stepErrors: Array<string | null> = [
    source === "csv"
      ? !csv
        ? "Upload a CSV file"
        : !phoneCol
          ? "Pick the column with phone numbers"
          : recipientCount === 0
            ? "No valid phone numbers in that column"
            : duplicateColumn
              ? `Two columns are both named "${duplicateColumn}" once normalized; rename one`
              : recipientCount > MAX_RECIPIENTS
                ? `At most ${formatNumber(MAX_RECIPIENTS)} recipients per campaign`
                : null
      : pasteStats.valid.length === 0
        ? "Paste at least one valid number"
        : pasteStats.valid.length > MAX_RECIPIENTS
          ? `At most ${formatNumber(MAX_RECIPIENTS)} recipients per campaign`
          : null,
    !name.trim()
      ? "Name the campaign"
      : !sender || !isValidSender(sender)
        ? "Pick a valid sender"
        : !body.trim()
          ? "Write the message"
          : missing.length > 0
            ? `No column for ${missing.map((m) => `{${m}}`).join(", ")}`
            : rendered && rendered.tooLong > 0
            ? `${formatNumber(rendered.tooLong)} rendered messages exceed ${MAX_PARTS} parts`
            : null,
    when === "schedule" && !(new Date(scheduledAt).getTime() > Date.now())
      ? "The schedule time must be in the future"
      : null,
  ];

  const next = () => {
    const err = stepErrors[step];
    if (err) {
      toast.error(err);
      return;
    }
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  };

  /* -------------------------------------------------------------- create */

  const create = async () => {
    const err = stepErrors.find(Boolean);
    if (err) {
      toast.error(err);
      return;
    }
    setSubmitting(true);
    const scheduled = when === "schedule" ? new Date(scheduledAt).toISOString() : null;
    try {
      let campaign: Campaign;
      if (source === "csv" && csv && file && phoneCol) {
        let upload = file;
        if (normalizeColumn(phoneCol) !== "phone") {
          // The api requires a "phone" header: rename the chosen column (and move any other "phone" aside).
          const headers = csv.headers.map((h) =>
            h === phoneCol ? "phone" : normalizeColumn(h) === "phone" ? `${normalizeColumn(h)}_original` : h,
          );
          upload = new File([toCsv(headers, csv.rows)], file.name.replace(/\.[^.]+$/, "") + ".csv", { type: "text/csv" });
        }
        campaign = await api.campaigns.createUpload({
          file: upload,
          name: name.trim(),
          source_addr: sender.trim(),
          body,
          scheduled_at: scheduled,
        });
      } else if (pasteStats.valid.length > JSON_MAX_RECIPIENTS) {
        const upload = new File([toCsv(["phone"], pasteStats.valid.map((p) => [p]))], "recipients.csv", { type: "text/csv" });
        campaign = await api.campaigns.createUpload({
          file: upload,
          name: name.trim(),
          source_addr: sender.trim(),
          body,
          scheduled_at: scheduled,
        });
      } else {
        campaign = await api.campaigns.createJson({
          name: name.trim(),
          source_addr: sender.trim(),
          body,
          recipients: pasteStats.valid.map((phone) => ({ phone })),
          scheduled_at: scheduled,
        });
      }
      const imp = campaign.import;
      if (imp && (imp.invalid_rows > 0 || imp.duplicate_rows > 0)) {
        toast.info(`Imported ${formatNumber(campaign.total)} recipients`, {
          description: `${formatNumber(imp.invalid_rows)} invalid and ${formatNumber(imp.duplicate_rows)} duplicate rows skipped.`,
        });
      }
      if (when === "now") {
        try {
          await api.campaigns.start(campaign.id);
          toast.success("Campaign started");
        } catch (e) {
          toast.error("Campaign created but couldn't start", { description: errorMessage(e) });
        }
      } else {
        toast.success(when === "schedule" ? "Campaign scheduled" : "Draft saved");
      }
      router.push(`/campaigns/${campaign.id}`);
    } catch (e) {
      toast.error("Couldn't create the campaign", { description: errorMessage(e) });
      setSubmitting(false);
    }
  };

  /* -------------------------------------------------------------- render */

  return (
    <>
      <PageHeader title="New campaign" back={{ href: "/campaigns", label: "Campaigns" }} />

      <ol className="mb-6 flex flex-wrap items-center gap-2 text-sm" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            <button
              type="button"
              disabled={i > step && stepErrors.slice(0, i).some(Boolean)}
              onClick={() => (i <= step || !stepErrors.slice(0, i).some(Boolean) ? setStep(i) : undefined)}
              className={cn(
                "flex items-center gap-2 rounded-full border px-3 py-1",
                i === step ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground",
                "disabled:opacity-50",
              )}
              aria-current={i === step ? "step" : undefined}
            >
              <span className="tabular-nums">{i < step ? <Check className="h-3.5 w-3.5" aria-hidden /> : i + 1}</span>
              {s}
            </button>
            {i < STEPS.length - 1 ? <span className="text-muted-foreground" aria-hidden>→</span> : null}
          </li>
        ))}
      </ol>

      {step === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recipients</CardTitle>
            <CardDescription>Upload a CSV (first line = header, one column with phone numbers) or paste a list.</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs value={source} onValueChange={(v) => setSource(v as Source)}>
              <TabsList>
                <TabsTrigger value="csv">
                  <FileSpreadsheet className="mr-1.5 h-4 w-4" aria-hidden /> Upload CSV
                </TabsTrigger>
                <TabsTrigger value="paste">Paste numbers</TabsTrigger>
              </TabsList>
              <TabsContent value="csv" className="mt-4 space-y-4">
                <div
                  className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-center"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const f = e.dataTransfer.files?.[0];
                    if (f) void loadFile(f);
                  }}
                >
                  <Upload className="h-6 w-6 text-muted-foreground" aria-hidden />
                  <p className="text-sm">{file ? file.name : "Drop a CSV here or"}</p>
                  <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={parsing}>
                    {parsing ? <Loader2 className="animate-spin" aria-hidden /> : null}
                    {file ? "Choose another file" : "Choose file"}
                  </Button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden"
                    aria-label="CSV file"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void loadFile(f);
                      e.target.value = "";
                    }}
                  />
                  {fileError ? <p className="text-sm text-destructive">{fileError}</p> : null}
                </div>

                {csv ? (
                  <>
                    <div className="grid gap-4 sm:grid-cols-[16rem_1fr] sm:items-end">
                      <div className="space-y-2">
                        <Label htmlFor="phone-col">Phone column</Label>
                        <Select value={phoneCol ?? ""} onValueChange={setPhoneCol}>
                          <SelectTrigger id="phone-col">
                            <SelectValue placeholder="Pick a column" />
                          </SelectTrigger>
                          <SelectContent>
                            {csv.headers.map((h) => (
                              <SelectItem key={h} value={h}>
                                {h}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                        <span>
                          <span className="font-medium text-foreground">{formatNumber(csv.rows.length)}</span> rows
                        </span>
                        <span>{csv.headers.length} columns</span>
                        {csvRecipients ? (
                          <>
                            <span>
                              <span className="font-medium text-foreground">{formatNumber(csvRecipients.total)}</span> valid numbers
                            </span>
                            {csvRecipients.duplicates ? <span>{formatNumber(csvRecipients.duplicates)} duplicates</span> : null}
                            {csvRecipients.invalid.length ? (
                              <span className="text-destructive">
                                {formatNumber(csvRecipients.invalid.length)} invalid ({csvRecipients.invalid.slice(0, 3).join(", ")}
                                {csvRecipients.invalid.length > 3 ? "…" : ""}) will be skipped
                              </span>
                            ) : null}
                          </>
                        ) : null}
                        {csv.ragged ? <span className="text-warning">{formatNumber(csv.ragged)} rows have a different number of cells</span> : null}
                      </div>
                    </div>
                    <div className="overflow-x-auto rounded-md border">
                      <Table>
                        <caption className="sr-only">CSV preview</caption>
                        <TableHeader>
                          <TableRow>
                            {csv.headers.map((h) => (
                              <TableHead key={h} className="whitespace-nowrap">
                                {h}
                                {h === phoneCol ? (
                                  <Badge variant="secondary" className="ml-2">
                                    phone
                                  </Badge>
                                ) : null}
                              </TableHead>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {csv.rows.slice(0, 5).map((r, i) => (
                            <TableRow key={i}>
                              {csv.headers.map((h, j) => (
                                <TableCell key={h} className={cn("max-w-[14rem] truncate", h === phoneCol && "font-mono")}>
                                  {r[j] ?? ""}
                                </TableCell>
                              ))}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    {columns.length > 0 ? (
                      <p className="text-xs text-muted-foreground">
                        Placeholders available in the message:{" "}
                        {columns.map((c) => (
                          <code key={c} className="mr-1 font-mono">{`{${c}}`}</code>
                        ))}
                      </p>
                    ) : null}
                    {stepErrors[0] && csv ? <p className="text-[0.8rem] font-medium text-destructive">{stepErrors[0]}</p> : null}
                  </>
                ) : null}
              </TabsContent>
              <TabsContent value="paste" className="mt-4">
                <RecipientsInput value={pasted} onChange={setPasted} stats={pasteStats} />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      ) : null}

      {step === 1 ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <Card>
            <CardContent className="space-y-5 pt-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="campaign-name">Campaign name</Label>
                  <Input id="campaign-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder="October promo" />
                </div>
                <SenderInput value={sender} onChange={setSender} />
              </div>
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Label htmlFor="campaign-body">Message</Label>
                  <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Insert placeholder">
                    <span className="text-xs text-muted-foreground">Insert:</span>
                    {columns.length === 0 ? (
                      <span className="text-xs text-muted-foreground">
                        {source === "csv" ? "no extra columns" : "upload a CSV for personalisation"}
                      </span>
                    ) : null}
                    {columns.map((c) => (
                      <Button key={c} type="button" variant="outline" size="sm" className="h-6 px-2 font-mono text-xs" onClick={() => insertPlaceholder(c)}>
                        {`{${c}}`}
                      </Button>
                    ))}
                  </div>
                </div>
                <Textarea
                  id="campaign-body"
                  ref={bodyRef}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={7}
                  maxLength={5000}
                  placeholder={columns.length > 0 ? `Hi {${columns[0]}}, …` : "Your message…"}
                />
                <SmsCounter
                  text={body}
                  onFix={setBody}
                  note={placeholders.length ? "template length; see preview for rendered messages" : undefined}
                />
                {missing.length > 0 ? (
                  <p className="text-[0.8rem] font-medium text-destructive">
                    No column for {missing.map((m) => `{${m}}`).join(", ")}. Use one of the buttons above (column names are
                    lower-case with “_” for spaces).
                  </p>
                ) : null}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Preview</CardTitle>
              <CardDescription>First recipients, rendered.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {sample.slice(0, 3).map((r) => {
                const text = renderTemplate(body, r.vars);
                const a = analyzeSms(text);
                return (
                  <div key={r.phone} className="space-y-1 rounded-md border bg-muted/30 p-3">
                    <p className="font-mono text-xs text-muted-foreground">{r.phone}</p>
                    <p className="whitespace-pre-wrap break-words text-sm">{text || <span className="text-muted-foreground">(empty)</span>}</p>
                    <p className="text-xs text-muted-foreground">
                      {a.encoding === "GSM7" ? "GSM-7" : "UCS-2"} · {a.parts} {a.parts === 1 ? "part" : "parts"}
                    </p>
                  </div>
                );
              })}
              {rendered ? (
                <p className="text-xs text-muted-foreground">
                  Longest message: {rendered.maxParts} {rendered.maxParts === 1 ? "part" : "parts"}
                  {rendered.ucs2 ? ` · ${formatNumber(rendered.ucs2)} in Unicode` : ""}
                  {sample.length < recipientCount ? ` (first ${formatNumber(sample.length)} analysed)` : ""}
                </p>
              ) : null}
            </CardContent>
          </Card>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">When</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <RadioGroup value={when} onValueChange={(v) => setWhen(v as When)} className="space-y-2">
                <label className="flex items-start gap-3 rounded-md border p-3">
                  <RadioGroupItem value="now" className="mt-0.5" />
                  <span>
                    <span className="block text-sm font-medium">Send now</span>
                    <span className="text-xs text-muted-foreground">Starts immediately after creation.</span>
                  </span>
                </label>
                <label className="flex items-start gap-3 rounded-md border p-3">
                  <RadioGroupItem value="schedule" className="mt-0.5" />
                  <span className="flex-1 space-y-2">
                    <span className="block text-sm font-medium">Schedule</span>
                    <Input
                      type="datetime-local"
                      value={scheduledAt}
                      min={localDateTimeValue(new Date())}
                      onChange={(e) => {
                        setScheduledAt(e.target.value);
                        setWhen("schedule");
                      }}
                      aria-label="Scheduled time"
                      className="max-w-xs"
                    />
                    <span className="block text-xs text-muted-foreground">
                      Your local time ({Intl.DateTimeFormat().resolvedOptions().timeZone}).
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-3 rounded-md border p-3">
                  <RadioGroupItem value="draft" className="mt-0.5" />
                  <span>
                    <span className="block text-sm font-medium">Save as draft</span>
                    <span className="text-xs text-muted-foreground">Start it later from the campaign page.</span>
                  </span>
                </label>
              </RadioGroup>
              {stepErrors[2] ? <p className="text-[0.8rem] font-medium text-destructive">{stepErrors[2]}</p> : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Review</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <ReviewRow label="Name" value={name} />
              <ReviewRow label="Sender" value={<span className="font-mono">{sender}</span>} />
              <ReviewRow label="Recipients" value={formatNumber(recipientCount)} />
              <ReviewRow label="Longest message" value={rendered ? `${rendered.maxParts} parts` : "—"} />
              <ReviewRow
                label={estimate?.extrapolated ? "Estimated cost (extrapolated)" : "Estimated cost"}
                value={estimate ? <Money micros={estimate.total} currency={currency} /> : "—"}
              />
              <ReviewRow
                label="Balance"
                value={balance.data ? <Money micros={balance.data.balance_micros} currency={currency} /> : "—"}
              />
              {estimate && estimate.unpriced > 0 ? (
                <p className="text-xs text-warning">
                  {formatNumber(estimate.unpriced)} analysed numbers have no route and will fail.
                </p>
              ) : null}
              {senders.restricted && !senders.approved.some((s) => s.sender.toLowerCase() === sender.toLowerCase()) ? (
                <Alert variant="destructive" className="mt-2">
                  <AlertTitle>Sender not approved</AlertTitle>
                  <AlertDescription>Messages will be rejected with SENDER_NOT_ALLOWED.</AlertDescription>
                </Alert>
              ) : null}
            </CardContent>
          </Card>
        </div>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
        <Button variant="outline" onClick={() => (step === 0 ? router.push("/campaigns") : setStep(step - 1))} disabled={submitting}>
          <ArrowLeft aria-hidden /> {step === 0 ? "Cancel" : "Back"}
        </Button>
        {step < STEPS.length - 1 ? (
          <Button onClick={next}>
            Next <ArrowRight aria-hidden />
          </Button>
        ) : (
          <Button onClick={create} disabled={submitting || stepErrors.some(Boolean)}>
            {submitting ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : when === "now" ? (
              <Rocket aria-hidden />
            ) : when === "schedule" ? (
              <CalendarClock aria-hidden />
            ) : (
              <Save aria-hidden />
            )}
            {when === "now" ? "Create & send" : when === "schedule" ? "Schedule campaign" : "Save draft"}
          </Button>
        )}
      </div>
    </>
  );
}

function ReviewRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium tabular-nums">{value || "—"}</span>
    </div>
  );
}
