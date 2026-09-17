/**
 * ServersPage — route /servers
 * Renders the existing Inventory component (full CRUD).
 * Admin users see the registration form and action buttons.
 * Viewer users only see the read-only table (Inventory hides write actions
 * when isAdmin is false via the useAuth hook).
 */
import Inventory from "../components/Inventory.jsx";

export default function ServersPage() {
  return <Inventory />;
}
