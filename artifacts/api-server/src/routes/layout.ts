import { Router, type Request, type Response } from "express";
import { eq, asc, ne, count, like, and } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  roomsTable,
  channelsTable,
  racksTable,
  traysTable,
  cyclesTable,
} from "@workspace/db";

const router = Router();

// No-op as of Task 1 of the onboarding-wizard plan (2026-08-01): rooms now require a
// facilityId (roomsTable.facilityId is NOT NULL, composite-unique on (facilityId, name)
// -- see lib/db/src/schema/index.ts), so an unconditional 3-room auto-seed with no
// facility context no longer type-checks and would be wrong even if it did (rooms are
// per-facility now, not global). This function is superseded by `POST /facilities`
// (Task 2 of the same plan), which creates a facility's rooms transactionally. Left as
// a no-op (rather than deleted) so existing call sites below don't need to change yet;
// Task 2 removes this function and its call sites once the real facility-scoped route
// lands.
async function ensureRoomsExist() {
  return;
}

router.get("/layout", async (req: Request, res: Response) => {
  try {
    await ensureRoomsExist();

    const rooms = await db
      .select()
      .from(roomsTable)
      .orderBy(asc(roomsTable.sortOrder));

    const channels = await db
      .select()
      .from(channelsTable)
      .orderBy(asc(channelsTable.positionIndex));

    const racks = await db
      .select()
      .from(racksTable)
      .orderBy(asc(racksTable.positionIndex));

    const trays = await db
      .select()
      .from(traysTable)
      .orderBy(asc(traysTable.positionIndex));

    const result = rooms.map((room) => {
      const roomChannels = channels
        .filter((c) => c.roomId === room.id)
        .map((channel) => {
          const channelRacks = racks
            .filter((r) => r.channelId === channel.id)
            .map((rack) => {
              const rackTrays = trays
                .filter((t) => t.rackId === rack.id)
                .map((tray) => ({
                  id: tray.id,
                  label: tray.label,
                  positionIndex: tray.positionIndex,
                }));
              return {
                id: rack.id,
                label: rack.label,
                positionIndex: rack.positionIndex,
                trays: rackTrays,
              };
            });
          return {
            id: channel.id,
            label: channel.label,
            positionIndex: channel.positionIndex,
            monitoringApiTemp: channel.monitoringApiTemp ?? null,
            monitoringApiWaterLevel: channel.monitoringApiWaterLevel ?? null,
            monitoringApiPh: channel.monitoringApiPh ?? null,
            racks: channelRacks,
          };
        });
      return {
        id: room.id,
        name: room.name,
        sortOrder: room.sortOrder,
        channels: roomChannels,
      };
    });

    return res.json(result);
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to fetch layout" });
  }
});

router.post("/layout/channels", async (req: Request, res: Response) => {
  try {
    await ensureRoomsExist();
    const { roomId, label } = req.body;
    if (!roomId || !label) {
      return res.status(400).json({ error: "roomId and label are required" });
    }

    const existingChannels = await db
      .select()
      .from(channelsTable)
      .where(eq(channelsTable.roomId, roomId));

    const [channel] = await db
      .insert(channelsTable)
      .values({
        roomId,
        label,
        positionIndex: existingChannels.length,
      })
      .returning();

    return res.status(201).json({
      id: channel.id,
      label: channel.label,
      positionIndex: channel.positionIndex,
      monitoringApiTemp: channel.monitoringApiTemp ?? null,
      monitoringApiWaterLevel: channel.monitoringApiWaterLevel ?? null,
      monitoringApiPh: channel.monitoringApiPh ?? null,
      racks: [],
    });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to create channel" });
  }
});

router.patch("/layout/channels/:id", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    const { label, positionIndex } = req.body;

    const updates: Partial<typeof channelsTable.$inferInsert> = {};
    if (label !== undefined) updates.label = label;
    if (positionIndex !== undefined) updates.positionIndex = positionIndex;

    const [channel] = await db
      .update(channelsTable)
      .set(updates)
      .where(eq(channelsTable.id, id))
      .returning();

    if (!channel) return res.status(404).json({ error: "Channel not found" });

    return res.json({
      id: channel.id,
      label: channel.label,
      positionIndex: channel.positionIndex,
      monitoringApiTemp: channel.monitoringApiTemp ?? null,
      monitoringApiWaterLevel: channel.monitoringApiWaterLevel ?? null,
      monitoringApiPh: channel.monitoringApiPh ?? null,
    });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to update channel" });
  }
});

router.delete("/layout/channels/:id", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    const [deleted] = await db
      .delete(channelsTable)
      .where(eq(channelsTable.id, id))
      .returning();

    if (!deleted) return res.status(404).json({ error: "Channel not found" });
    return res.json({ success: true });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to delete channel" });
  }
});

router.patch(
  "/layout/channels/:id/monitoring",
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params["id"] as string, 10);
      const { monitoringApiTemp, monitoringApiWaterLevel, monitoringApiPh } =
        req.body;

      const [channel] = await db
        .update(channelsTable)
        .set({
          monitoringApiTemp: monitoringApiTemp ?? null,
          monitoringApiWaterLevel: monitoringApiWaterLevel ?? null,
          monitoringApiPh: monitoringApiPh ?? null,
        })
        .where(eq(channelsTable.id, id))
        .returning();

      if (!channel) return res.status(404).json({ error: "Channel not found" });

      return res.json({
        id: channel.id,
        monitoringApiTemp: channel.monitoringApiTemp ?? null,
        monitoringApiWaterLevel: channel.monitoringApiWaterLevel ?? null,
        monitoringApiPh: channel.monitoringApiPh ?? null,
      });
    } catch (err) {
      req.log.error(err);
      return res
        .status(500)
        .json({ error: "Failed to update monitoring config" });
    }
  },
);

router.post("/layout/racks", async (req: Request, res: Response) => {
  try {
    const { channelId, label } = req.body;
    if (!channelId || !label) {
      return res.status(400).json({ error: "channelId and label are required" });
    }

    const existingRacks = await db
      .select()
      .from(racksTable)
      .where(eq(racksTable.channelId, channelId));

    const [rack] = await db
      .insert(racksTable)
      .values({
        channelId,
        label,
        positionIndex: existingRacks.length,
      })
      .returning();

    return res.status(201).json({
      id: rack.id,
      label: rack.label,
      positionIndex: rack.positionIndex,
      trays: [],
    });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to create rack" });
  }
});

router.patch("/layout/racks/:id", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    const { label, positionIndex } = req.body;

    const updates: Partial<typeof racksTable.$inferInsert> = {};
    if (label !== undefined) updates.label = label;
    if (positionIndex !== undefined) updates.positionIndex = positionIndex;

    const [rack] = await db
      .update(racksTable)
      .set(updates)
      .where(eq(racksTable.id, id))
      .returning();

    if (!rack) return res.status(404).json({ error: "Rack not found" });
    return res.json({
      id: rack.id,
      label: rack.label,
      positionIndex: rack.positionIndex,
    });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to update rack" });
  }
});

router.patch("/layout/racks/:id/tray-count", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    const count = parseInt(req.body.count, 10);

    if (isNaN(count) || count < 0) {
      return res.status(400).json({ error: "count must be a non-negative integer" });
    }

    const rack = await db.select().from(racksTable).where(eq(racksTable.id, id)).then((r) => r[0]);
    if (!rack) return res.status(404).json({ error: "Rack not found" });

    const existing = await db
      .select()
      .from(traysTable)
      .where(eq(traysTable.rackId, id))
      .orderBy(asc(traysTable.positionIndex));

    if (count > existing.length) {
      const toCreate = count - existing.length;
      const inserts = Array.from({ length: toCreate }, (_, i) => ({
        rackId: id,
        label: `Tray ${existing.length + i + 1}`,
        positionIndex: existing.length + i,
      }));
      await db.insert(traysTable).values(inserts);
    } else if (count < existing.length) {
      const toDelete = existing.slice(count).map((t) => t.id);
      for (const tid of toDelete) {
        await db.delete(traysTable).where(eq(traysTable.id, tid));
      }
    }

    return res.json({ rackId: id, count });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to update tray count" });
  }
});

router.delete("/layout/racks/:id", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    const [deleted] = await db
      .delete(racksTable)
      .where(eq(racksTable.id, id))
      .returning();

    if (!deleted) return res.status(404).json({ error: "Rack not found" });
    return res.json({ success: true });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to delete rack" });
  }
});

router.post("/layout/trays", async (req: Request, res: Response) => {
  try {
    const { rackId, label } = req.body;
    if (!rackId || !label) {
      return res.status(400).json({ error: "rackId and label are required" });
    }

    const existingTrays = await db
      .select()
      .from(traysTable)
      .where(eq(traysTable.rackId, rackId));

    const [tray] = await db
      .insert(traysTable)
      .values({
        rackId,
        label,
        positionIndex: existingTrays.length,
      })
      .returning();

    return res.status(201).json({
      id: tray.id,
      label: tray.label,
      positionIndex: tray.positionIndex,
    });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to create tray" });
  }
});

router.delete("/layout/trays/:id", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    const [deleted] = await db
      .delete(traysTable)
      .where(eq(traysTable.id, id))
      .returning();

    if (!deleted) return res.status(404).json({ error: "Tray not found" });
    return res.json({ success: true });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to delete tray" });
  }
});

/**
 * GET /layout/channels-status — tray-position availability for every
 * channel in one call (Alpha App Phase 7's Channel Utilization drill-down
 * panel). Same totalTrays/activeCycles/availableTrays computation
 * /layout/resolve already does per-channel, but done as one grouped pass
 * over bulk-fetched rows instead of N+1 calls to /resolve.
 */
router.get("/layout/channels-status", async (req: Request, res: Response) => {
  try {
    await ensureRoomsExist();

    const rooms = await db.select().from(roomsTable).orderBy(asc(roomsTable.sortOrder));
    const channels = await db.select().from(channelsTable).orderBy(asc(channelsTable.positionIndex));
    const racks = await db.select().from(racksTable);
    const trays = await db.select().from(traysTable);
    const activeCycles = await db
      .select({ trayPosition: cyclesTable.trayPosition })
      .from(cyclesTable)
      .where(ne(cyclesTable.status, "completed"));

    const result = rooms.flatMap((room) =>
      channels
        .filter((channel) => channel.roomId === room.id)
        .map((channel) => {
          const channelRackIds = new Set(
            racks.filter((r) => r.channelId === channel.id).map((r) => r.id),
          );
          const totalTrays = trays.filter((t) => channelRackIds.has(t.rackId)).length;
          const activeCount = activeCycles.filter(
            (c) =>
              c.trayPosition?.includes(`"room":"${room.name}"`) &&
              c.trayPosition?.includes(`"channel":"${channel.label}"`),
          ).length;
          const availableTrays = Math.max(0, totalTrays - activeCount);

          return {
            channelId: channel.id,
            room: room.name,
            channel: channel.label,
            totalTrays,
            activeCycles: activeCount,
            availableTrays,
            isFull: totalTrays > 0 && activeCount >= totalTrays,
            monitoringApiTemp: channel.monitoringApiTemp ?? null,
            monitoringApiWaterLevel: channel.monitoringApiWaterLevel ?? null,
            monitoringApiPh: channel.monitoringApiPh ?? null,
          };
        }),
    );

    return res.json(result);
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to fetch channel status" });
  }
});

router.get("/layout/resolve", async (req: Request, res: Response) => {
  try {
    const room = (req.query["room"] as string | undefined)?.toLowerCase().trim();
    const channel = (req.query["channel"] as string | undefined)?.trim();
    const rack = (req.query["rack"] as string | undefined)?.trim();

    if (!room || !channel) {
      return res.status(400).json({ error: "room and channel query params required" });
    }

    await ensureRoomsExist();

    const [roomRow] = await db
      .select()
      .from(roomsTable)
      .where(eq(roomsTable.name, room as "seeding" | "fertigation" | "harvesting"));

    if (!roomRow) {
      return res.status(404).json({ error: "Room not found" });
    }

    const allChannels = await db
      .select()
      .from(channelsTable)
      .where(eq(channelsTable.roomId, roomRow.id));

    const channelRow = allChannels.find(
      (c) => c.label.toLowerCase() === channel.toLowerCase()
    );

    if (!channelRow) {
      return res.status(404).json({ error: "Channel not found" });
    }

    // Total trays defined in this channel's layout
    const [totalTraysRow] = await db
      .select({ count: count(traysTable.id) })
      .from(traysTable)
      .innerJoin(racksTable, eq(traysTable.rackId, racksTable.id))
      .where(eq(racksTable.channelId, channelRow.id));
    const totalTrays = Number(totalTraysRow?.count ?? 0);

    // Active (non-completed) cycles assigned to this channel
    const [activeCyclesRow] = await db
      .select({ count: count(cyclesTable.id) })
      .from(cyclesTable)
      .where(
        and(
          ne(cyclesTable.status, "completed"),
          like(cyclesTable.trayPosition, `%"room":"${roomRow.name}"%`),
          like(cyclesTable.trayPosition, `%"channel":"${channelRow.label}"%`),
        ),
      );
    const activeCycles = Number(activeCyclesRow?.count ?? 0);
    const availableTrays = Math.max(0, totalTrays - activeCycles);
    const isFull = totalTrays > 0 && activeCycles >= totalTrays;

    const result: Record<string, unknown> = {
      channelId: channelRow.id,
      room: roomRow.name,
      channel: channelRow.label,
      totalTrays,
      activeCycles,
      availableTrays,
      isFull,
      monitoringApiTemp: channelRow.monitoringApiTemp ?? null,
      monitoringApiWaterLevel: channelRow.monitoringApiWaterLevel ?? null,
      monitoringApiPh: channelRow.monitoringApiPh ?? null,
    };

    if (rack) {
      const allRacks = await db
        .select()
        .from(racksTable)
        .where(eq(racksTable.channelId, channelRow.id));

      const rackRow = allRacks.find(
        (r) => r.label.toLowerCase() === rack.toLowerCase()
      );

      if (rackRow) {
        const rackTrays = await db
          .select()
          .from(traysTable)
          .where(eq(traysTable.rackId, rackRow.id));

        result["rackId"] = rackRow.id;
        result["rack"] = rackRow.label;
        result["trayCount"] = rackTrays.length;
      }
    }

    return res.json(result);
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to resolve QR" });
  }
});

export { ensureRoomsExist };
export default router;
