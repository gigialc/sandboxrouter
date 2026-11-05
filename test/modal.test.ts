import { describe, expect, it, vi } from "vitest";

const created: Record<string, unknown>[] = [];
vi.mock("modal", () => ({
  ModalClient: class {
    apps = { fromName: async () => ({}) };
    images = { fromRegistry: () => ({}) };
    sandboxes = {
      create: async (_app: unknown, _image: unknown, opts: Record<string, unknown>) => {
        created.push(opts);
        return { sandboxId: "sb-1" };
      },
    };
  },
}));

const { ModalProvider } = await import("../src/providers/modal.js");

describe("ModalProvider", () => {
  it("asks Modal for physical cores (1 core = 2 vCPUs), so the catalog price matches what runs", async () => {
    await new ModalProvider().create({ vcpu: 4, memoryGb: 8 });
    await new ModalProvider().create({});
    expect(created[0]).toMatchObject({ cpu: 2, memoryMiB: 8192 });
    expect(created[1]).toMatchObject({ cpu: 1, memoryMiB: 4096 });
  });
});
