import "@/index.css";
import { mountWidget } from "skybridge/web";

function IncidentBrief() {
  return (
    <div className="p-4 text-sm text-gray-500">Incident Commander is fully conversational — no widget UI needed.</div>
  );
}

export default IncidentBrief;

mountWidget(<IncidentBrief />);
