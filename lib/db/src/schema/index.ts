import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  numeric,
  timestamp,
  date,
  pgEnum,
  index,
  uniqueIndex,
  real,
  check,
  primaryKey,
  jsonb,
  vector,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const cycleStatusEnum = pgEnum("cycle_status", [
  "germination",
  "fertigation",
  "harvest",
  "completed",
]);

export const alertSeverityEnum = pgEnum("alert_severity", [
  "critical",
  "warning",
]);

export const alertStatusEnum = pgEnum("alert_status", [
  "current",
  "resolved",
  "dismissed",
]);

export const shipmentStatusEnum = pgEnum("shipment_status", [
  "in_progress",
  "complete",
  "pending",
]);

export const sensorTypeEnum = pgEnum("sensor_type", [
  "temp",
  "ph",
  "water",
  "humidity",
  "ec",
]);

export const taskTypeEnum = pgEnum("task_type", [
  "seed",
  "transplant",
  "harvest",
  "inspect",
]);

export const taskStatusEnum = pgEnum("task_status", [
  "pending",
  "in_progress",
  "done",
]);

export const badTraySeverityEnum = pgEnum("bad_tray_severity", [
  "low",
  "medium",
  "high",
]);

export const stockMovementReasonEnum = pgEnum("stock_movement_reason", [
  "purchase",
  "consume",
  "adjust",
]);

export const cropCategoryEnum = pgEnum("crop_category", [
  "leafy",
  "herb",
  "brassica",
  "legume",
  "cereal",
  "other",
]);

export const userRoleEnum = pgEnum("user_role", [
  "technician",
  "lead",
  "supervisor",
]);

export const usersTable = pgTable("users", {
  id: uuid("id").primaryKey(), // matches auth.users.id — not generated here, Supabase owns it
  email: text("email").notNull(),
  role: userRoleEnum("role").notNull().default("technician"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const cropsTable = pgTable("crops", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  scientificName: text("scientific_name"),
  category: cropCategoryEnum("category"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const growthProfilesTable = pgTable("growth_profiles", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  seedName: text("seed_name").notNull(),
  germinationDays: integer("germination_days").notNull(),
  fertigationDays: integer("fertigation_days").notNull(),
  cropId: integer("crop_id").references(() => cropsTable.id, {
    onDelete: "set null",
  }),
  lightPpfd: integer("light_ppfd"),
  lightHours: numeric("light_hours"),
  germinationTempC: numeric("germination_temp_c"),
  germinationRhPct: numeric("germination_rh_pct"),
  fertigationTempC: numeric("fertigation_temp_c"),
  fertigationRhPct: numeric("fertigation_rh_pct"),
  ecTarget: numeric("ec_target"),
  phTargetMin: numeric("ph_target_min"),
  phTargetMax: numeric("ph_target_max"),
  expectedYieldPerTrayKg: numeric("expected_yield_per_tray_kg"),
  seedDensityGramsPerTray: numeric("seed_density_grams_per_tray"),
  trayType: text("tray_type"),
});

export const seedLotsTable = pgTable("seed_lots", {
  id: serial("id").primaryKey(),
  qrCode: text("qr_code").notNull().unique(),
  seedName: text("seed_name").notNull(),
  supplier: text("supplier"),
  productLink: text("product_link"),
  itemNumber: text("item_number"),
  vendorShort: text("vendor_short"),
  gpcCode: text("gpc_code"),
  type: text("type"),
  success: numeric("success"),
  growTime: numeric("grow_time"),
  usedIn: text("used_in"),
  currentlyGrown: boolean("currently_grown"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const cyclesTable = pgTable(
  "cycles",
  {
    id: serial("id").primaryKey(),
    shortId: text("short_id").notNull().unique(),
    seedLotQrCodes: text("seed_lot_qr_codes").array().notNull(),
    seedName: text("seed_name").notNull(),
    fullTrays: integer("full_trays").notNull().default(0),
    halfTrays: integer("half_trays").notNull().default(0),
    seedWeightTray: numeric("seed_weight_tray").notNull(),
    growthProfileId: integer("growth_profile_id")
      .notNull()
      .references(() => growthProfilesTable.id),
    seedingDate: date("seeding_date").notNull(),
    status: cycleStatusEnum("status").notNull().default("germination"),
    trayPosition: text("tray_position"),
    germinationStartedAt: timestamp("germination_started_at"),
    fertigationStartedAt: timestamp("fertigation_started_at"),
    harvestStartedAt: timestamp("harvest_started_at"),
    harvestedQty: numeric("harvested_qty"),
    closedAt: timestamp("closed_at"),
    trayId: integer("tray_id").references(() => traysTable.id, { onDelete: "set null" }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    index("cycles_status_idx").on(table.status),
    index("cycles_closed_at_idx").on(table.closedAt),
    index("cycles_created_at_idx").on(table.createdAt),
    check("cycles_full_trays_nonneg", sql`${table.fullTrays} >= 0`),
    check("cycles_half_trays_nonneg", sql`${table.halfTrays} >= 0`),
  ],
);

export const manualChecksTable = pgTable(
  "manual_checks",
  {
    id: serial("id").primaryKey(),
    cycleId: integer("cycle_id")
      .notNull()
      .references(() => cyclesTable.id, { onDelete: "restrict" }),
    fullTrays: integer("full_trays").notNull().default(0),
    halfTrays: integer("half_trays").notNull().default(0),
    isBadTrays: boolean("is_bad_trays").notNull().default(false),
    issue: text("issue"),
    notes: text("notes"),
    photoUrls: text("photo_urls").array().notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("manual_checks_created_at_idx").on(table.createdAt),
    index("manual_checks_cycle_id_idx").on(table.cycleId),
  ],
);

export const alertsTable = pgTable("alerts", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  location: text("location"),
  severity: alertSeverityEnum("severity").notNull().default("warning"),
  status: alertStatusEnum("status").notNull().default("current"),
  actionType: text("action_type"),
  actionNotes: text("action_notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at"),
},
  (table) => [
    index("alerts_status_idx").on(table.status),
    uniqueIndex("alerts_current_title_location_uniq")
      .on(table.title, table.location)
      .where(sql`${table.status} = 'current'`),
  ],
);

export const inventoryItemsTable = pgTable("inventory_items", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  brand: text("brand"),
  category: text("category"),
  qrCode: text("qr_code"),
  currentQty: numeric("current_qty").notNull().default("0"),
  maxQty: numeric("max_qty").notNull().default("0"),
  unit: text("unit").notNull().default("g"),
  arrivalDate: date("arrival_date"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
},
  (table) => [
    index("inventory_category_idx").on(table.category),
    check("inventory_qty_range", sql`${table.currentQty} <= ${table.maxQty}`),
  ],
);

export const shipmentsTable = pgTable("shipments", {
  id: serial("id").primaryKey(),
  shortId: text("short_id").notNull().unique(),
  client: text("client").notNull(),
  productDescription: text("product_description"),
  yieldSoldKg: numeric("yield_sold_kg"),
  revenueUsd: numeric("revenue_usd"),
  shippingDate: date("shipping_date"),
  status: shipmentStatusEnum("status").notNull().default("pending"),
  cycleId: integer("cycle_id").references(() => cyclesTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
},
  (table) => [
    index("shipments_status_idx").on(table.status),
    index("shipments_shipping_date_idx").on(table.shippingDate),
  ],
);

export const facilitiesTable = pgTable("facilities", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const roomNameEnum = pgEnum("room_name", [
  "seeding",
  "fertigation",
  "harvesting",
]);

export const roomsTable = pgTable("rooms", {
  id: serial("id").primaryKey(),
  name: roomNameEnum("name").notNull().unique(),
  sortOrder: integer("sort_order").notNull().default(0),
  facilityId: integer("facility_id").references(() => facilitiesTable.id, {
    onDelete: "set null",
  }),
});

export const channelsTable = pgTable("channels", {
  id: serial("id").primaryKey(),
  roomId: integer("room_id")
    .notNull()
    .references(() => roomsTable.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  positionIndex: integer("position_index").notNull().default(0),
  monitoringApiTemp: text("monitoring_api_temp"),
  monitoringApiWaterLevel: text("monitoring_api_water_level"),
  monitoringApiPh: text("monitoring_api_ph"),
});

export const racksTable = pgTable("racks", {
  id: serial("id").primaryKey(),
  channelId: integer("channel_id")
    .notNull()
    .references(() => channelsTable.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  positionIndex: integer("position_index").notNull().default(0),
});

export const traysTable = pgTable("trays", {
  id: serial("id").primaryKey(),
  rackId: integer("rack_id")
    .notNull()
    .references(() => racksTable.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  positionIndex: integer("position_index").notNull().default(0),
});

export const sensorStatusTable = pgTable("sensor_status", {
  id: serial("id").primaryKey(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  sensorsOnline: integer("sensors_online"),
  sensorsTotal: integer("sensors_total"),
  acidityPh: real("acidity_ph"),
  waterLevelPct: real("water_level_pct"),
  tempCelsius: real("temp_celsius"),
  humidityPct: real("humidity_pct"),
  nutrientMix: text("nutrient_mix"),
});

// ── Phase 2a: additive domain tables ─────────────────────────────────────────

export const sensorsTable = pgTable(
  "sensors",
  {
    id: serial("id").primaryKey(),
    channelId: integer("channel_id").references(() => channelsTable.id, {
      onDelete: "cascade",
    }),
    rackId: integer("rack_id").references(() => racksTable.id, {
      onDelete: "cascade",
    }),
    type: sensorTypeEnum("type").notNull(),
    label: text("label").notNull(),
    unit: text("unit"),
    lastValue: numeric("last_value"),
    lastReadAt: timestamp("last_read_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("sensors_channel_id_idx").on(table.channelId),
    index("sensors_rack_id_idx").on(table.rackId),
    check(
      "sensors_placement",
      sql`${table.channelId} IS NOT NULL OR ${table.rackId} IS NOT NULL`,
    ),
  ],
);

export const sensorReadingsTable = pgTable(
  "sensor_readings",
  {
    id: serial("id").primaryKey(),
    sensorId: integer("sensor_id")
      .notNull()
      .references(() => sensorsTable.id, { onDelete: "cascade" }),
    metric: text("metric").notNull(),
    value: numeric("value").notNull(),
    readAt: timestamp("read_at").notNull().defaultNow(),
  },
  (table) => [
    index("sensor_readings_sensor_id_idx").on(table.sensorId),
    // BRIN is ideal for append-only time-series (E1 sizing note).
    index("sensor_readings_read_at_brin").using("brin", table.readAt),
  ],
);

export const cycleSeedLotsTable = pgTable(
  "cycle_seed_lots",
  {
    cycleId: integer("cycle_id")
      .notNull()
      .references(() => cyclesTable.id, { onDelete: "cascade" }),
    seedLotId: integer("seed_lot_id")
      .notNull()
      .references(() => seedLotsTable.id, { onDelete: "cascade" }),
    qty: numeric("qty"),
  },
  (table) => [primaryKey({ columns: [table.cycleId, table.seedLotId] })],
);

export const tasksTable = pgTable(
  "tasks",
  {
    id: serial("id").primaryKey(),
    cycleId: integer("cycle_id").references(() => cyclesTable.id, {
      onDelete: "cascade",
    }),
    type: taskTypeEnum("type").notNull(),
    status: taskStatusEnum("status").notNull().default("pending"),
    assignee: text("assignee"),
    dueAt: timestamp("due_at"),
    completedAt: timestamp("completed_at"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("tasks_status_idx").on(table.status),
    index("tasks_due_at_idx").on(table.dueAt),
    index("tasks_cycle_id_idx").on(table.cycleId),
  ],
);

export const badTrayEntriesTable = pgTable(
  "bad_tray_entries",
  {
    id: serial("id").primaryKey(),
    cycleId: integer("cycle_id")
      .notNull()
      .references(() => cyclesTable.id, { onDelete: "restrict" }),
    trayId: integer("tray_id").references(() => traysTable.id, {
      onDelete: "set null",
    }),
    issue: text("issue"),
    severity: badTraySeverityEnum("severity"),
    fullTrays: integer("full_trays").notNull().default(0),
    halfTrays: integer("half_trays").notNull().default(0),
    photoUrls: text("photo_urls").array().notNull().default([]),
    lossEstimate: numeric("loss_estimate"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("bad_tray_entries_cycle_id_idx").on(table.cycleId),
    index("bad_tray_entries_created_at_idx").on(table.createdAt),
  ],
);

export const stockMovementsTable = pgTable(
  "stock_movements",
  {
    id: serial("id").primaryKey(),
    inventoryItemId: integer("inventory_item_id")
      .notNull()
      .references(() => inventoryItemsTable.id, { onDelete: "cascade" }),
    cycleId: integer("cycle_id").references(() => cyclesTable.id, {
      onDelete: "set null",
    }),
    delta: numeric("delta").notNull(),
    reason: stockMovementReasonEnum("reason").notNull().default("adjust"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("stock_movements_inventory_item_id_idx").on(table.inventoryItemId),
    index("stock_movements_created_at_idx").on(table.createdAt),
  ],
);

// ── Phase 4: per-user settings (metric selection, layout order, etc.) ───────

export const userSettingsTable = pgTable(
  "user_settings",
  {
    id: serial("id").primaryKey(),
    clerkUserId: text("clerk_user_id").notNull(),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("user_settings_user_key_uniq").on(table.clerkUserId, table.key),
  ],
);

// ── Accounting tab: external provider OAuth connections ─────────────────────

export const accountingProviderEnum = pgEnum("accounting_provider", [
  "quickbooks",
]);

export const accountingConnectionsTable = pgTable(
  "accounting_connections",
  {
    id: serial("id").primaryKey(),
    clerkUserId: text("clerk_user_id").notNull(),
    provider: accountingProviderEnum("provider").notNull().default("quickbooks"),
    realmId: text("realm_id").notNull(),
    companyName: text("company_name"),
    // Tokens stored AES-256-GCM encrypted (iv + authTag + ciphertext, base64),
    // never plaintext at rest. Decrypted only in-process when calling the API.
    accessTokenEnc: text("access_token_enc").notNull(),
    refreshTokenEnc: text("refresh_token_enc").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("accounting_connections_user_provider_uniq").on(
      table.clerkUserId,
      table.provider,
    ),
  ],
);

// ── Recommender: cached external knowledge + question history ──────────────
// Requires the pgvector extension (CREATE EXTENSION IF NOT EXISTS vector;),
// enabled once via migration. Embeddings are Gemini gemini-embedding-001
// (output_dimensionality=1536) — see artifacts/recommender-svc.

export const recommenderCacheTable = pgTable(
  "recommender_cache",
  {
    id: serial("id").primaryKey(),
    sourceUrl: text("source_url").notNull(),
    title: text("title"),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
    fetchedAt: timestamp("fetched_at").notNull().defaultNow(),
    searchProvider: text("search_provider").notNull(), // 'tavily' | 'brave'
    queryText: text("query_text").notNull(),
  },
  (table) => [
    index("recommender_cache_source_url_idx").on(table.sourceUrl),
    index("recommender_cache_embedding_hnsw").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
  ],
);

export const recommenderQueriesTable = pgTable(
  "recommender_queries",
  {
    id: serial("id").primaryKey(),
    clerkUserId: text("clerk_user_id").notNull(),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    sources: jsonb("sources"), // [{title, url}]
    farmContextUsed: jsonb("farm_context_used"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("recommender_queries_user_idx").on(table.clerkUserId),
    index("recommender_queries_created_at_idx").on(table.createdAt),
  ],
);

// ── Alpha App Phase 4.3: facility compliance logs (mobile-only feature) ─────
// One shared table + jsonb payload (matches recommender_queries.sources/
// farm_context_used) rather than six separate tables — per-type Zod schemas
// on the API give type safety without a migration every time a field changes.

export const facilityLogTypeEnum = pgEnum("facility_log_type", [
  "maintenance",
  "waste",
  "env_check",
  "cleaning",
  "receiving",
  "visitor",
]);

export const facilityLogsTable = pgTable(
  "facility_logs",
  {
    id: serial("id").primaryKey(),
    logType: facilityLogTypeEnum("log_type").notNull(),
    clerkUserId: text("clerk_user_id").notNull(),
    data: jsonb("data").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("facility_logs_type_created_at_idx").on(table.logType, table.createdAt),
  ],
);
