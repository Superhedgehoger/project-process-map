export type ComponentHealth = {
  component: string;
  status: "ok" | "degraded";
  version: string;
};

export type HealthReport = {
  status: "ok" | "degraded";
  checkedAt: string;
  components: ComponentHealth[];
};

