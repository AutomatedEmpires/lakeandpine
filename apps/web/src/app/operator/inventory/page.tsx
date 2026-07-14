import type { Metadata } from "next";

import { OperatorDenied, OwnerBootstrap } from "@/components/OperatorAccessState";
import { OperatorTeamNav } from "@/components/OperatorTeamNav";
import { resolveOperatorIdentity } from "@/lib/auth";
import { hasCapability } from "@/lib/team-operations";
import { getOperationsDashboard } from "@/lib/team-operations-data";

import {
  createInventoryProductAction,
  recordInventoryUsageAction,
  reviewRestockAction,
} from "../team-operations-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Team inventory", robots: { index: false, follow: false } };

function money(cents: number | null) {
  return cents === null ? "Not recorded" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export default async function InventoryPage({ searchParams }: { searchParams: Promise<{ team?: string }> }) {
  const identity = await resolveOperatorIdentity();
  if (identity.state !== "authed" && identity.state !== "preview") return <OperatorDenied identity={identity} />;
  const params = await searchParams;
  const dashboard = await getOperationsDashboard({ customerId: identity.operator.id, devOnly: identity.devOnly, requestedTeamId: params.team });
  if (!dashboard.access.organizationId) return <OwnerBootstrap dashboard={dashboard} />;
  const canManage = dashboard.selectedTeamId ? hasCapability(dashboard.access.memberships, "manage_inventory", dashboard.access.organizationId, dashboard.selectedTeamId) : false;
  const canApprove = dashboard.selectedTeamId ? hasCapability(dashboard.access.memberships, "approve_restock", dashboard.access.organizationId, dashboard.selectedTeamId) : false;

  return (
    <div className="route-page operator-page">
      <section className="container page-hero">
        <div className="operator-hero">
          <div><span className="eyebrow">Team supply control</span><h1>Inventory + replenishment</h1><p className="lead">A perpetual ledger records every receipt, use, waste, and adjustment. Thresholds create purchase drafts; a person still approves every order.</p></div>
          <div className="card operator-summary"><span>Tracked products</span><strong>{dashboard.inventory.length}</strong><span>Below threshold</span><strong>{dashboard.inventory.filter((item) => item.on_hand <= item.reorder_point).length}</strong></div>
        </div>
        <OperatorTeamNav dashboard={dashboard} current="inventory" />
      </section>

      <section className="container section team-operations-section">
        {!dashboard.selectedTeam && <div className="card empty-operator"><h2>Create or select a team.</h2><p className="copy">Inventory is deliberately empty for every new team.</p></div>}
        {dashboard.selectedTeam && <>
          <div className="inventory-card-grid">
            {dashboard.inventory.map((item) => {
              const low = item.on_hand <= item.reorder_point;
              return <article className={`card inventory-card${low ? " low" : ""}`} key={`${item.id}-${item.location_id}`}>
                <div className="operator-panel-head"><div><span className="eyebrow">{item.sku} · {item.category.replaceAll("_", " ")}</span><h2>{item.name}</h2></div><span className={`status-badge ${low ? "watch" : "healthy"}`}>{low ? "restock" : "in range"}</span></div>
                <div className="inventory-balance"><strong>{item.on_hand}</strong><span>{item.unit_label} on hand</span></div>
                <div className="metric-grid compact"><div><span>Reorder at</span><strong>{item.reorder_point}</strong></div><div><span>Target</span><strong>{item.target_level}</strong></div><div><span>Location</span><strong>{item.location_name}</strong></div><div><span>Unit cost</span><strong>{money(item.unit_cost_cents)}</strong></div></div>
                {(item.preferred_vendor || item.purchase_url) && <p className="copy">{item.preferred_vendor || "Preferred vendor"}{item.purchase_url && <> · <a href={item.purchase_url} rel="noreferrer" target="_blank">Purchase source</a></>}</p>}
              </article>;
            })}
            {dashboard.inventory.length === 0 && <article className="card empty-operator"><h2>This team&apos;s supply room is empty.</h2><p className="copy">Add approved products below; no other team&apos;s catalog is inherited.</p></article>}
          </div>

          <div className="operations-grid team-admin-grid">
            {canManage && <article className="card operator-panel">
              <span className="eyebrow">Approved catalog</span><h2>Add a team product</h2>
              <form action={createInventoryProductAction} className="operations-form-grid">
                <input type="hidden" name="teamId" value={dashboard.selectedTeamId!} />
                <label>Product name<input name="name" required /></label><label>SKU<input name="sku" required placeholder="GLASS-001" /></label>
                <label>Category<select name="category"><option value="chemical">Chemical</option><option value="paper">Paper</option><option value="tool">Tool</option><option value="ppe">PPE</option><option value="liner">Liner</option><option value="marine">Marine</option><option value="finish_care">Finish care</option><option value="general">General</option></select></label>
                <label>Unit label<input name="unitLabel" defaultValue="each" required /></label>
                <label>Opening count<input name="initialCount" type="number" min="0" step="0.001" defaultValue="0" required /></label>
                <label>Reorder point<input name="reorderPoint" type="number" min="0" step="0.001" defaultValue="0" required /></label>
                <label>Target level<input name="targetLevel" type="number" min="0" step="0.001" defaultValue="0" required /></label>
                <label>Unit cost ($)<input name="unitCostDollars" type="number" min="0" step="0.01" /></label>
                <label>Preferred vendor<input name="preferredVendor" /></label><label>Purchase URL<input name="purchaseUrl" type="url" placeholder="https://…" /></label>
                <label>Product image URL<input name="imageUrl" type="url" placeholder="https://…" /></label>
                <button className="btn btn-primary">Add product + opening ledger</button>
              </form>
            </article>}

            {dashboard.inventory.length > 0 && <article className="card operator-panel">
              <span className="eyebrow">Stock movement</span><h2>Log team usage</h2>
              <form action={recordInventoryUsageAction} className="operations-form-grid">
                <input type="hidden" name="teamId" value={dashboard.selectedTeamId!} />
                <label>Product + location<select name="inventoryKey" required>{dashboard.inventory.map((item) => <option key={`${item.id}-${item.location_id}`} value={`${item.id}|${item.location_id}`}>{item.name} · {item.location_name} · {item.on_hand} {item.unit_label}</option>)}</select></label>
                <label>Quantity used<input name="quantity" type="number" min="0.001" step="0.001" required /></label>
                <label>Note<input name="note" placeholder="Job, count, or reason" /></label>
                <button className="btn btn-primary">Record immutable usage</button>
              </form>
            </article>}
          </div>

          <article className="card operator-panel">
            <span className="eyebrow">Approval queue</span><h2>Restock requests</h2>
            <div className="ops-ledger-list">
              {dashboard.restocks.map((request) => <article key={request.id}>
                <div><span className={`status-badge ${request.status}`}>{request.status}</span><strong>{request.product_name}</strong><small>{request.quantity_requested} requested · {request.request_source.replaceAll("_", " ")} · {money(request.estimated_unit_cost_cents)} each</small></div>
                {request.purchase_url_snapshot && <a href={request.purchase_url_snapshot} rel="noreferrer" target="_blank">Open purchase source</a>}
                {canApprove && <div className="inline-action-row">
                  {request.status === "requested" && <><form action={reviewRestockAction}><input type="hidden" name="teamId" value={dashboard.selectedTeamId!} /><input type="hidden" name="restockId" value={request.id} /><input type="hidden" name="from" value="requested" /><input type="hidden" name="to" value="declined" /><input type="hidden" name="version" value={request.version} /><button className="btn btn-soft">Decline</button></form><form action={reviewRestockAction}><input type="hidden" name="teamId" value={dashboard.selectedTeamId!} /><input type="hidden" name="restockId" value={request.id} /><input type="hidden" name="from" value="requested" /><input type="hidden" name="to" value="approved" /><input type="hidden" name="version" value={request.version} /><button className="btn btn-primary">Approve draft</button></form></>}
                  {request.status === "approved" && <form action={reviewRestockAction}><input type="hidden" name="teamId" value={dashboard.selectedTeamId!} /><input type="hidden" name="restockId" value={request.id} /><input type="hidden" name="from" value="approved" /><input type="hidden" name="to" value="ordered" /><input type="hidden" name="version" value={request.version} /><button className="btn btn-primary">Mark externally ordered</button></form>}
                  {request.status === "ordered" && <form action={reviewRestockAction}><input type="hidden" name="teamId" value={dashboard.selectedTeamId!} /><input type="hidden" name="restockId" value={request.id} /><input type="hidden" name="from" value="ordered" /><input type="hidden" name="to" value="received" /><input type="hidden" name="version" value={request.version} /><button className="btn btn-primary">Receive into stock</button></form>}
                </div>}
              </article>)}
              {dashboard.restocks.length === 0 && <p className="copy">No restock requests. Threshold automation will create one draft per low-stock product.</p>}
            </div>
          </article>

          <article className="card operator-panel">
            <span className="eyebrow">Immutable provenance</span><h2>Who used or moved what</h2>
            <div className="ops-ledger-list">
              {dashboard.inventoryTransactions.map((movement) => <article key={movement.id}>
                <div><span className={`status-badge ${movement.quantity_delta < 0 ? "watch" : "healthy"}`}>{movement.transaction_type.replaceAll("_", " ")}</span><strong>{movement.product_name}</strong><small>{movement.quantity_delta > 0 ? "+" : ""}{movement.quantity_delta} · balance {movement.balance_after} · {movement.location_name}</small></div>
                <div><strong>{movement.performed_by}</strong><small>{new Date(movement.created_at).toLocaleString()}{movement.job_label ? ` · ${movement.job_label}` : ""}{movement.note ? ` · ${movement.note}` : ""}</small></div>
              </article>)}
              {dashboard.inventoryTransactions.length === 0 && <p className="copy">No inventory movement has been recorded for this team.</p>}
            </div>
          </article>
        </>}
      </section>
    </div>
  );
}
