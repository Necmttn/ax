import { Surreal, RecordId, surql } from "surrealdb";

export interface DbConfig {
    url: string;
    ns: string;
    db: string;
    user: string;
    pass: string;
}

export function envConfig(): DbConfig {
    return {
        url: process.env.AGENTCTL_DB_URL ?? "ws://127.0.0.1:8521",
        ns: process.env.AGENTCTL_DB_NS ?? "agentctl",
        db: process.env.AGENTCTL_DB_DB ?? "main",
        user: process.env.AGENTCTL_DB_USER ?? "root",
        pass: process.env.AGENTCTL_DB_PASS ?? "root",
    };
}

export async function connect(cfg: DbConfig = envConfig()): Promise<Surreal> {
    const db = new Surreal();
    await db.connect(cfg.url);
    await db.signin({ username: cfg.user, password: cfg.pass });
    await db.use({ namespace: cfg.ns, database: cfg.db });
    return db;
}

export { RecordId, surql };
