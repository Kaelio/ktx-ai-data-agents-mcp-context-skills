import type { Metadata } from "next";

import { DiagramStudio } from "@/components/diagram-studio/studio";

export const metadata: Metadata = {
  title: "Diagram studio",
  robots: { index: false, follow: false },
};

export default function DiagramStudioPage() {
  return <DiagramStudio />;
}
