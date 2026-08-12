import React, { useState, useRef, useEffect } from "react";
import {
  useListInventory,
  useCreateInventoryItem,
  useUpdateInventoryItem,
  useDeleteInventoryItem,
  useGetDashboard,
  getListInventoryQueryKey,
  type InventoryItem,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { formatNumber } from "@/lib/format";
import { Package, Plus, AlertCircle, Sprout, QrCode, Printer, Download, Pencil, Trash2 } from "lucide-react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip as RechartsTooltip } from "recharts";
import { toast } from "sonner";
import { QueryError } from "@/components/ui/query-error";
import { DataTable, type Column } from "@/components/data-table";
import QRCodeSVG from "react-qr-code";
import { getMetricDef } from "@workspace/metrics";
import { useMetricSelection } from "@/hooks/use-metric-selection";
import { MetricPicker } from "@/components/metrics/MetricPicker";
import { DraggableMetricGrid } from "@/components/metrics/DraggableMetricGrid";
import { MetricCard } from "@/components/metrics/MetricCard";
import { TimeRangeSelector, type MetricRange } from "@/components/metrics/TimeRangeSelector";
import type { MetricDataMap } from "@/components/metrics/renderers";
import { generateQRPayload, generateItemCode, formatArrivalDate } from "./qr-helpers";

type SeedLot = { id: number; seedName: string; qrCode: string };

// Helper: render a sticker sheet (PDF) for batch printing of selected items.
function printLabelSheet(items: InventoryItem[], qrSvgByItem: Map<number, string>): boolean {
  const win = window.open("", "_blank", "width=800,height=600");
  if (!win) return false;

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Sticker Sheet (PDF) — ${items.length} labels</title>
        <style>
          body { font-family: sans-serif; margin: 0; padding: 10mm; background: #f5f5f5; }
          .sticker { display: inline-block; width: 100mm; height: 80mm; margin: 5mm; padding: 10mm; background: white; border: 1px solid #ddd; page-break-inside: avoid; }
          .sticker svg { width: 60mm; height: 60mm; }
          .name { font-size: 14px; font-weight: 700; margin-top: 5mm; }
          .code { font-size: 11px; color: #555; margin-top: 2mm; }
          .label { font-size: 8px; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 2mm; }
          @media print { body { padding: 0; background: white; } }
        </style>
      </head>
      <body>
        ${items.map((item) => {
          const svg = qrSvgByItem.get(item.id) || "";
          const code = generateItemCode(item.id);
          const arrival = formatArrivalDate(item);
          return `
            <div class="sticker">
              ${svg}
              <div class="name">${item.name}</div>
              <div class="code">${code} · arrived ${arrival}</div>
              <div class="label">Inventory · FarmSmart</div>
            </div>
          `;
        }).join("")}
        <script>window.onload = () => { setTimeout(() => { window.print(); window.onafterprint = () => window.close(); }, 100); }<\/script>
      </body>
    </html>
  `;

  win.document.write(html);
  win.document.close();
  return true;
}

const itemSchema = z.object({
  name: z.string().min(1, "Name is required"),
  brand: z.string().optional(),
  category: z.string().optional(),
  currentQty: z.coerce.number().min(0),
  maxQty: z.coerce.number().min(1),
  unit: z.string().min(1, "Unit is required"),
});

export function Inventory() {
  const { data: inventory, isLoading: inventoryLoading, isError: inventoryError, refetch: refetchInventory } = useListInventory();
  const { data: dashboard, isLoading: dashboardLoading } = useGetDashboard();
  const createItem = useCreateInventoryItem();
  const updateItem = useUpdateInventoryItem();
  const deleteItem = useDeleteInventoryItem();
  const queryClient = useQueryClient();
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [editing, setEditing] = useState<InventoryItem | null>(null);
  const [deleting, setDeleting] = useState<InventoryItem | null>(null);
  const [qrLot, setQrLot] = useState<SeedLot | null>(null);
  const [qrItem, setQrItem] = useState<InventoryItem | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const itemPrintRef = useRef<HTMLDivElement>(null);
  const batchQrRef = useRef<HTMLDivElement>(null);
  const printRef = useRef<HTMLDivElement>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListInventoryQueryKey() });

  const form = useForm<z.infer<typeof itemSchema>>({
    resolver: zodResolver(itemSchema),
    defaultValues: { name: "", brand: "", category: "", currentQty: 0, maxQty: 100, unit: "kg" },
  });

  const openEdit = (item: InventoryItem) => {
    setEditing(item);
    form.reset({
      name: item.name,
      brand: item.brand ?? "",
      category: item.category ?? "",
      currentQty: item.currentQty,
      maxQty: item.maxQty,
      unit: item.unit,
    });
  };

  const onCreateSubmit = (data: z.infer<typeof itemSchema>) => {
    createItem.mutate({ data }, {
      onSuccess: () => {
        invalidate();
        setIsAddModalOpen(false);
        form.reset();
        toast("Item added successfully");
      },
      onError: () => toast.error("Failed to add item"),
    });
  };

  const onEditSubmit = (data: z.infer<typeof itemSchema>) => {
    if (!editing) return;
    updateItem.mutate({ id: editing.id, data }, {
      onSuccess: () => {
        invalidate();
        setEditing(null);
        form.reset();
        toast("Item updated");
      },
      onError: () => toast.error("Failed to update item"),
    });
  };

  const confirmDelete = () => {
    if (!deleting) return;
    deleteItem.mutate({ id: deleting.id }, {
      onSuccess: () => {
        invalidate();
        toast("Item deleted");
      },
      onError: () => toast.error("Failed to delete item"),
    });
    setDeleting(null);
  };

  const handlePrint = () => {
    if (!qrLot) return;
    const svgEl = printRef.current?.querySelector("svg");
    if (!svgEl) return;
    const svgData = new XMLSerializer().serializeToString(svgEl);
    const win = window.open("", "_blank", "width=400,height=500");
    if (!win) return;
    win.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>QR Code — ${qrLot.qrCode}</title>
          <style>
            body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #fff; }
            .lot-code { font-size: 13px; color: #555; margin-top: 12px; letter-spacing: 0.05em; }
            .seed-name { font-size: 18px; font-weight: 700; color: #1a1a1a; margin-top: 4px; }
            .label { font-size: 11px; color: #888; margin-top: 2px; text-transform: uppercase; letter-spacing: 0.08em; }
            svg { width: 200px; height: 200px; }
            @media print { @page { margin: 0.5cm; } }
          </style>
        </head>
        <body>
          ${svgData}
          <div class="seed-name">${qrLot.seedName}</div>
          <div class="lot-code">${qrLot.qrCode}</div>
          <div class="label">Seed Lot · FarmSmart</div>
          <script>window.onload = () => { window.print(); window.onafterprint = () => window.close(); }<\/script>
        </body>
      </html>
    `);
    win.document.close();
  };

  const handleDownloadSVG = () => {
    if (!qrLot) return;
    const svgEl = printRef.current?.querySelector("svg");
    if (!svgEl) return;
    const svgData = new XMLSerializer().serializeToString(svgEl);
    const blob = new Blob([svgData], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `qr-${qrLot.qrCode.replace(/[^a-z0-9]/gi, "-")}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Hooks must run unconditionally on every render (Rules of Hooks) — keep
  // these above the loading/error early returns below.
  const { selected, selectable, toggle, reorder, reset } = useMetricSelection("inventory");
  const [range, setRange] = useState<MetricRange>("30d");

  useEffect(() => {
    // CHK-002: the Farm Readiness card's "Add seeds with QR" deep link is
    // /inventory?category=Seeds (Task 12's backend, already shipped) — open
    // the Add Item modal pre-set to that category instead of just navigating
    // to a blank Inventory page.
    const params = new URLSearchParams(window.location.search);
    const category = params.get("category");
    if (category) {
      setIsAddModalOpen(true);
      form.setValue("category", category);
      params.delete("category");
      const newSearch = params.toString();
      window.history.replaceState({}, "", window.location.pathname + (newSearch ? `?${newSearch}` : ""));
    }
    // Intentionally empty deps — this is a one-time "consume the query param
    // this page was navigated to with" effect, not a reactive subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Only gate on inventory: dashboard is supplementary (seed-lot/crop counts,
  // seed-lot table) and its own errors/slowness must not blank the whole tab.
  if (inventoryLoading) {
    return <div className="p-6 space-y-6"><Skeleton className="h-[400px] w-full" /></div>;
  }
  void dashboardLoading;

  if (inventoryError) {
    return (
      <div className="p-6">
        <QueryError resource="inventory" onRetry={() => refetchInventory()} />
      </div>
    );
  }

  const items = inventory || [];
  const lowStockItems = items.filter((item) => item.currentQty / item.maxQty < 0.2);

  const chartData = items.reduce((acc, item) => {
    const cat = item.category || "Other";
    const existing = acc.find((x) => x.name === cat);
    if (existing) existing.value += 1;
    else acc.push({ name: cat, value: 1 });
    return acc;
  }, [] as { name: string; value: number }[]);

  const COLORS = ["hsl(var(--chart-1))", "hsl(var(--chart-2))", "hsl(var(--chart-3))", "hsl(var(--chart-4))", "hsl(var(--chart-5))"];

  const seedLots = (dashboard as { activeSeedLotDetails?: { id: number; seedName: string; qrCode: string }[] })?.activeSeedLotDetails || [];

  const metricData: MetricDataMap = { inventory: items, dashboard };

  const itemForm = (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(editing ? onEditSubmit : onCreateSubmit)} className="space-y-4">
        <FormField control={form.control} name="name" render={({ field }) => (
          <FormItem><FormLabel>Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
        )} />
        <div className="grid grid-cols-2 gap-4">
          <FormField control={form.control} name="brand" render={({ field }) => (
            <FormItem><FormLabel>Brand</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
          )} />
          <FormField control={form.control} name="category" render={({ field }) => (
            <FormItem><FormLabel>Category</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
          )} />
        </div>
        <div className="grid grid-cols-3 gap-4">
          <FormField control={form.control} name="currentQty" render={({ field }) => (
            <FormItem><FormLabel>Current Qty</FormLabel><FormControl><Input type="number" {...field} /></FormControl><FormMessage /></FormItem>
          )} />
          <FormField control={form.control} name="maxQty" render={({ field }) => (
            <FormItem><FormLabel>Max Qty</FormLabel><FormControl><Input type="number" {...field} /></FormControl><FormMessage /></FormItem>
          )} />
          <FormField control={form.control} name="unit" render={({ field }) => (
            <FormItem><FormLabel>Unit</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
          )} />
        </div>
        <Button type="submit" className="w-full" disabled={createItem.isPending || updateItem.isPending}>
          {editing ? (updateItem.isPending ? "Saving..." : "Save Changes") : (createItem.isPending ? "Adding..." : "Add Item")}
        </Button>
      </form>
    </Form>
  );

  const itemColumns: Column<InventoryItem>[] = [
    {
      key: "select",
      header: () => (
        <input
          type="checkbox"
          checked={selectedIds.size > 0 && items.every((i) => selectedIds.has(i.id))}
          onChange={() => {
            const ids = new Set(selectedIds);
            if (ids.size === items.length) ids.clear();
            else items.forEach((i) => ids.add(i.id));
            setSelectedIds(ids);
          }}
          aria-label="Select all items"
        />
      ),
      cell: (item: InventoryItem) => (
        <input
          type="checkbox"
          checked={selectedIds.has(item.id)}
          onChange={() => {
            const ids = new Set(selectedIds);
            if (ids.has(item.id)) ids.delete(item.id);
            else ids.add(item.id);
            setSelectedIds(ids);
          }}
          aria-label={`Select ${item.name}`}
        />
      ),
    },
    { key: "name", header: "Item", accessor: (i) => i.name, sortable: true, cell: (i) => <span className="font-medium">{i.name}</span> },
    { key: "category", header: "Category", accessor: (i) => i.category ?? "", sortable: true, cell: (i) => <span className="text-muted-foreground">{i.category ?? "—"}</span> },
    {
      key: "stock",
      header: "Stock Level",
      accessor: (i) => (i.maxQty ? (i.currentQty / i.maxQty) * 100 : 0),
      sortable: true,
      cell: (i) => {
        const pct = i.maxQty ? (i.currentQty / i.maxQty) * 100 : 0;
        const isLow = pct < 20;
        return (
          <div className="flex items-center gap-2">
            <Progress value={pct} className={`h-2 w-24 ${isLow ? "[&>div]:bg-destructive" : ""}`} />
            <span className={`text-xs ${isLow ? "text-destructive font-medium" : "text-muted-foreground"}`}>
              {pct.toFixed(0)}%
            </span>
          </div>
        );
      },
    },
    { key: "qty", header: "Qty", accessor: (i) => i.currentQty, sortable: true, align: "right", cell: (i) => `${formatNumber(i.currentQty)} ${i.unit}` },
    {
      key: "qr",
      header: "QR Label",
      align: "center",
      cell: (item: InventoryItem) => (
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-xs text-amber-700 hover:text-amber-900"
          onClick={() => setQrItem(item)}
        >
          <QrCode className="h-3.5 w-3.5" />
          <span className="text-amber-600">Generate</span>
        </Button>
      ),
    },
    {
      key: "actions",
      header: "Actions",
      align: "right",
      cell: (i) => (
        <div className="flex items-center justify-end gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Edit ${i.name}`} onClick={() => openEdit(i)}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" aria-label={`Delete ${i.name}`} onClick={() => setDeleting(i)}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Inventory Management</h1>
        <div className="flex items-center gap-2">
          <TimeRangeSelector range={range} onChange={setRange} />
          <MetricPicker
            tab="inventory"
            selectable={selectable}
            selected={selected}
            onToggle={toggle}
            onReset={reset}
          />
          <Dialog open={isAddModalOpen} onOpenChange={setIsAddModalOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-add-item">
              <Plus className="h-4 w-4 mr-2" />
              Add Item
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Add New Inventory Item</DialogTitle></DialogHeader>
            {itemForm}
          </DialogContent>
        </Dialog>
        </div>
      </div>

      {/* Metric cards (selectable) */}
      <DraggableMetricGrid
        ids={selected}
        onReorder={reorder}
        renderItem={(id) => {
          const def = getMetricDef(id);
          if (!def) return null;
          return <MetricCard def={def} data={metricData} range={range} />;
        }}
      />

      {/* Active Seed Lots */}
      {seedLots.length > 0 && (
        <Card className="shadow-sm">
          <CardHeader><span className="text-base font-semibold">Active Seed Lots in Rotation</span></CardHeader>
          <CardContent>
            <div className="rounded-md border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th scope="col" className="p-3 text-left font-medium">Lot Code</th>
                    <th scope="col" className="p-3 text-left font-medium">Crop Name</th>
                    <th scope="col" className="p-3 text-left font-medium">Status</th>
                    <th scope="col" className="p-3 text-right font-medium">QR Code</th>
                  </tr>
                </thead>
                <tbody>
                  {seedLots.map((lot) => (
                    <tr key={lot.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                      <td className="p-3 font-mono text-xs text-muted-foreground">{lot.qrCode}</td>
                      <td className="p-3 font-medium">{lot.seedName}</td>
                      <td className="p-3">
                        <Badge variant="secondary" className="bg-primary/10 text-primary border-primary/20">Growing</Badge>
                      </td>
                      <td className="p-3 text-right">
                        <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={() => setQrLot(lot)}>
                          <QrCode className="h-3.5 w-3.5" />
                          Generate QR
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* QR Code Modal */}
      <Dialog open={!!qrLot} onOpenChange={(open) => !open && setQrLot(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <QrCode className="h-5 w-5 text-primary" />
              Seed Lot QR Code
            </DialogTitle>
          </DialogHeader>
          {qrLot && (
            <div className="flex flex-col items-center gap-4 py-2">
              <div ref={printRef} className="bg-white p-4 rounded-xl border-2 border-border shadow-sm">
                <QRCodeSVG value={qrLot.qrCode} size={180} bgColor="#ffffff" fgColor="#1a1a1a" level="M" />
              </div>
              <div className="text-center space-y-0.5">
                <p className="text-base font-bold text-foreground">{qrLot.seedName}</p>
                <p className="text-xs font-mono text-muted-foreground">{qrLot.qrCode}</p>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mt-1">Seed Lot · FarmSmart</p>
              </div>
              <div className="flex gap-2 w-full pt-1">
                <Button variant="outline" className="flex-1 gap-2" onClick={handleDownloadSVG}>
                  <Download className="h-4 w-4" />
                  Download SVG
                </Button>
                <Button className="flex-1 gap-2" onClick={handlePrint}>
                  <Printer className="h-4 w-4" />
                  Print
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* InventoryItem QR Modal */}
      <Dialog open={!!qrItem} onOpenChange={(open) => !open && setQrItem(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <QrCode className="h-5 w-5 text-primary" />
              QR Label
            </DialogTitle>
          </DialogHeader>
          {qrItem && (
            <div className="flex flex-col items-center gap-4 py-2">
              <div ref={itemPrintRef} className="bg-white p-4 rounded-xl border-2 border-border shadow-sm">
                <QRCodeSVG value={generateQRPayload(qrItem)} size={180} bgColor="#ffffff" fgColor="#1a1a1a" level="M" />
              </div>
              <div className="text-center space-y-0.5">
                <p className="text-base font-bold text-foreground">{qrItem.name}</p>
                <p className="text-xs font-mono text-muted-foreground">{generateItemCode(qrItem.id)} · arrived {formatArrivalDate(qrItem)}</p>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mt-1">Inventory · FarmSmart</p>
              </div>
              <div className="flex gap-2 w-full pt-1">
                <Button variant="outline" className="flex-1 gap-2" onClick={() => {
                  const svgEl = itemPrintRef.current?.querySelector("svg");
                  if (!svgEl) return;
                  const svgData = new XMLSerializer().serializeToString(svgEl);
                  const svgBlob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
                  const url = URL.createObjectURL(svgBlob);
                  const img = new Image();
                  const code = generateItemCode(qrItem.id);
                  img.onload = () => {
                    const canvas = document.createElement("canvas");
                    canvas.width = img.width;
                    canvas.height = img.height;
                    const ctx = canvas.getContext("2d");
                    if (ctx) ctx.drawImage(img, 0, 0);
                    canvas.toBlob((blob) => {
                      if (!blob) return;
                      const pngUrl = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = pngUrl;
                      a.download = `qr-${code}.png`;
                      a.click();
                      URL.revokeObjectURL(pngUrl);
                      URL.revokeObjectURL(url);
                    });
                  };
                  img.src = url;
                }}>
                  <Download className="h-4 w-4" />
                  Download PNG
                </Button>
                <Button className="flex-1 gap-2" onClick={() => {
                  const svgEl = itemPrintRef.current?.querySelector("svg");
                  if (!svgEl) return;
                  const svgData = new XMLSerializer().serializeToString(svgEl);
                  const code = generateItemCode(qrItem.id);
                  const arrival = formatArrivalDate(qrItem);
                  const win = window.open("", "_blank", "width=400,height=500");
                  if (!win) return;
                  win.document.write(`
                    <!DOCTYPE html>
                    <html>
                      <head>
                        <title>QR Label — ${code}</title>
                        <style>
                          body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #fff; }
                          .name { font-size: 18px; font-weight: 700; color: #1a1a1a; margin-top: 8px; }
                          .code { font-size: 12px; color: #555; margin-top: 6px; }
                          .label { font-size: 10px; color: #888; margin-top: 6px; text-transform: uppercase; letter-spacing: 0.08em; }
                          svg { width: 200px; height: 200px; }
                          @media print { @page { margin: 0.5cm; } }
                        </style>
                      </head>
                      <body>
                        ${svgData}
                        <div class="name">${qrItem.name}</div>
                        <div class="code">${code} · arrived ${arrival}</div>
                        <div class="label">Inventory · FarmSmart</div>
                        <script>window.onload = () => { window.print(); window.onafterprint = () => window.close(); }<\/script>
                      </body>
                    </html>
                  `);
                  win.document.close();
                }}>
                  <Printer className="h-4 w-4" />
                  Print
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Supplies Stock + Categories */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <Card className="shadow-sm">
            <CardHeader>
              <div className="flex items-center justify-between">
                <span className="text-base font-semibold">Supplies Stock</span>
                {selectedIds.size > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">{selectedIds.size} selected</span>
                    <Button
                      size="sm"
                      className="gap-1.5"
                      onClick={() => {
                        const qrSvgs = new Map<number, string>();
                        const root = batchQrRef.current;
                        if (root) {
                          const svgs = root.querySelectorAll("svg");
                          const ordered = Array.from(selectedIds).map((id) => items.find((i) => i.id === id)).filter(Boolean) as InventoryItem[];
                          svgs.forEach((svg, idx) => {
                            const item = ordered[idx];
                            if (item) qrSvgs.set(item.id, new XMLSerializer().serializeToString(svg));
                          });
                        }
                        const itemsToPrint = Array.from(selectedIds).map((id) => items.find((i) => i.id === id)).filter(Boolean) as InventoryItem[];
                        const ok = printLabelSheet(itemsToPrint, qrSvgs);
                        if (!ok) toast.error("Pop-up blocked — allow pop-ups to print labels");
                      }}
                    >
                      <Printer className="h-4 w-4" />
                      Print Labels
                    </Button>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <DataTable
                data={items}
                columns={itemColumns}
                rowKey={(i) => i.id}
                searchFn={(i, t) =>
                  i.name.toLowerCase().includes(t) ||
                  (i.brand ?? "").toLowerCase().includes(t) ||
                  (i.category ?? "").toLowerCase().includes(t)
                }
                searchPlaceholder="Filter by item, brand, or category…"
                emptyState="No inventory items yet."
                caption="Supplies stock"
              />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="shadow-sm">
            <CardHeader><span className="text-base font-semibold">By Category</span></CardHeader>
            <CardContent>
              <div className="h-[250px]">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={chartData} innerRadius={60} outerRadius={80} paddingAngle={5} dataKey="value">
                      {chartData.map((_, index) => <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />)}
                    </Pie>
                    <RechartsTooltip />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="flex flex-wrap gap-2 justify-center mt-4">
                {chartData.map((entry, index) => (
                  <div key={entry.name} className="flex items-center gap-1 text-xs">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
                    <span>{entry.name}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Edit dialog */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit Inventory Item</DialogTitle></DialogHeader>
          {itemForm}
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deleting?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the item from inventory. This action can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Hidden container for batch QR rendering */}
      <div ref={batchQrRef} style={{ display: "none" }}>
        {Array.from(selectedIds).map((id) => {
          const item = items.find((i) => i.id === id);
          if (!item) return null;
          return <QRCodeSVG key={item.id} value={generateQRPayload(item)} size={60} bgColor="#ffffff" fgColor="#1a1a1a" level="M" />;
        })}
      </div>
    </div>
  );
}
