import { SignIn } from "@clerk/nextjs";
import { redirect } from "next/navigation";

import { authEnabled } from "@/lib/env";

export default function SignInPage() {
  if (!authEnabled) redirect("/dashboard");
  return (
    <div className="route-page">
      <div className="container page-hero" style={{ display: "grid", placeItems: "center" }}>
        <SignIn />
      </div>
    </div>
  );
}
