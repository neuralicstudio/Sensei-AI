"use client";

import type React from "react";

import { useState, useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Calendar, X } from "lucide-react";
import toast from "react-hot-toast";
import { CountrySelect } from "@/components/shared/country-select";
import { CardItinerary } from "@/app/types";
import { parseSafariDate } from "@/lib/utils";
import {
  emptyIntakeData,
  intakeDataForApi,
  normalizeBuildMode,
  parseIntakeData,
  validateIntakeAdvisorClientSection,
  validateIntakeForPagodaBuild,
  type ItineraryBuildMode,
  type ItineraryIntakeData,
} from "@/lib/itinerary-intake";
import { ItineraryIntakeFields } from "@/components/itineraries/itinerary-intake-fields";

function isProfileRequiredError(data: { code?: string; error?: string } | null): boolean {
  if (!data) return false;
  if (data.code === "PROFILE_REQUIRED") return true;
  const msg = (data.error || "").toLowerCase();
  return msg.includes("profile not found") || msg.includes("complete your profile");
}

function settingsHrefForPath(pathname: string | null): string {
  if (pathname?.startsWith("/agency")) return "/settings";
  if (pathname?.startsWith("/agent")) return "/agent/settings";
  return "/settings";
}

interface CreateItineraryModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onItineraryCreated?: (itinerary: CardItinerary) => void;
  itinerary?: CardItinerary | null; // For edit mode
}

// Helper function to calculate duration (Safari-compatible)
const calculateDuration = (startDate: string, endDate: string) => {
  const start = parseSafariDate(startDate);
  const end = parseSafariDate(endDate);
  if (!start || !end) return "1 Days";
  const diffDays = Math.max(
    1,
    Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1
  );
  return `${diffDays} Days`;
};

export function CreateItineraryModal({
  open,
  onOpenChange,
  onItineraryCreated,
  itinerary,
}: CreateItineraryModalProps) {
  const isEditMode = !!itinerary;
  const router = useRouter();
  const pathname = usePathname();
  const [formData, setFormData] = useState({
    itineraryName: "",
    country: "Japan",
    startDate: "",
    endDate: "",
  });
  const [buildMode, setBuildMode] = useState<ItineraryBuildMode>("pagoda_build");
  const [intake, setIntake] = useState<ItineraryIntakeData>(emptyIntakeData);
  // Always reflects the latest committed intake so handleSenseiGenerate
  // can't read stale state from a previous render's closure.
  const intakeRef = useRef(intake);
  intakeRef.current = intake;
  const [submitting, setSubmitting] = useState(false);
  const [senseiStatusMsg, setSenseiStatusMsg] = useState("");
  const [profileRequiredOpen, setProfileRequiredOpen] = useState(false);

  // Load itinerary data when in edit mode
  useEffect(() => {
    if (isEditMode && itinerary && open) {
      const loadItineraryData = async () => {
        try {
          const resp = await fetch(`/api/itineraries/${itinerary.id}`, {
            cache: "no-store",
          });
          const data = await resp.json().catch(() => null);
          
          if (resp.ok && data?.ok && data?.itinerary) {
            const it = data.itinerary;
            setFormData({
              itineraryName: it.name || itinerary.title || "",
              country: it.location || itinerary.location || "",
              startDate: it.start_date || itinerary.startDate || "",
              endDate: it.end_date || itinerary.endDate || "",
            });
            setBuildMode(normalizeBuildMode(it.build_mode));
            setIntake(parseIntakeData(it.intake_data));
          } else {
            // Fallback to basic itinerary data if API fails
            setFormData({
              itineraryName: itinerary.title || "",
              country: itinerary.location || "",
              startDate: itinerary.startDate || "",
              endDate: itinerary.endDate || "",
            });
          }
        } catch (error) {
          console.error("Error loading itinerary data:", error);
          // Fallback to basic data
          setFormData({
            itineraryName: itinerary.title || "",
            country: itinerary.location || "",
            startDate: itinerary.startDate || "",
            endDate: itinerary.endDate || "",
          });
        }
      };

      loadItineraryData();
    } else if (!isEditMode && open) {
      // Reset form when opening in create mode
      setFormData({
        itineraryName: "",
        country: "Japan",
        startDate: "",
        endDate: "",
      });
      setBuildMode("pagoda_build");
      setIntake(emptyIntakeData());
    }
  }, [isEditMode, itinerary, open]);

  // New itineraries should identify the signed-in advisor automatically.
  useEffect(() => {
    if (!open || isEditMode) return;

    let cancelled = false;
    const loadAdvisorName = async () => {
      try {
        const response = await fetch("/api/auth/me", { cache: "no-store" });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.ok || cancelled) return;

        const advisorName = [data.user?.name, data.user?.lastName]
          .filter((part): part is string => typeof part === "string" && Boolean(part.trim()))
          .map((part) => part.trim())
          .join(" ");
        if (!advisorName) return;

        setIntake((prev) => ({
          ...prev,
          advisorName: prev.advisorName?.trim() || advisorName,
        }));
      } catch {
        // The form remains editable if account details cannot be loaded.
      }
    };

    void loadAdvisorName();
    return () => {
      cancelled = true;
    };
  }, [isEditMode, open]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validation
    if (
      !formData.itineraryName ||
      !formData.country ||
      !formData.startDate ||
      !formData.endDate
    ) {
      toast.error("Please fill all required fields.");
      return;
    }

    const startDate = parseSafariDate(formData.startDate);
    const endDate = parseSafariDate(formData.endDate);
    if (!startDate || !endDate) {
      toast.error("Please enter valid dates.");
      return;
    }
    if (endDate < startDate) {
      toast.error("Departure date cannot be before Arrival date.");
      return;
    }

    if (buildMode === "pagoda_build") {
      const intakeErr = validateIntakeForPagodaBuild(intake);
      if (intakeErr) {
        toast.error(intakeErr);
        return;
      }
    } else {
      const section1Err = validateIntakeAdvisorClientSection(intake);
      if (section1Err) {
        toast.error(section1Err);
        return;
      }
    }

    setSubmitting(true);
    try {
      if (isEditMode && itinerary) {
        const resp = await fetch(`/api/itineraries/${itinerary.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: formData.itineraryName,
            location: formData.country,
            start_date: formData.startDate,
            end_date: formData.endDate,
            build_mode: buildMode,
            intake_data: intakeDataForApi(intake),
          }),
        });

        const data = await resp.json().catch(() => null);
        if (!resp.ok || !data?.ok) {
          throw new Error(data?.error || "Failed to update itinerary");
        }

        toast.success("Itinerary updated!");

        // Reset form and close modal
        setFormData({
          itineraryName: "",
          country: "Japan",
          startDate: "",
          endDate: "",
        });
        setBuildMode("pagoda_build");
        setIntake(emptyIntakeData());
        onOpenChange(false);

        // Call the callback with the updated itinerary
        if (onItineraryCreated && data.itinerary) {
          const updatedItinerary: CardItinerary = {
            id: String(data.itinerary.id),
            title: String(data.itinerary.name),
            location: String(data.itinerary.location),
            startDate: String(data.itinerary.start_date),
            endDate: String(data.itinerary.end_date),
            duration: calculateDuration(
              String(data.itinerary.start_date),
              String(data.itinerary.end_date)
            ),
            jobsCount: itinerary.jobsCount || 0,
            unassignedCount: itinerary.unassignedCount || 0,
            activities: itinerary.activities || [],
            status: data.itinerary.status || itinerary.status || "draft",
            image: itinerary.image,
          };
          onItineraryCreated(updatedItinerary);
        } else {
          // Refresh the page to show the updated itinerary if no callback provided
          window.location.reload();
        }
      } else {
        // Create new itinerary
        const status = "draft";

        const resp = await fetch("/api/itineraries", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: formData.itineraryName,
            location: formData.country,
            startDate: formData.startDate,
            endDate: formData.endDate,
            status: status,
            buildMode,
            intakeData: intakeDataForApi(intake),
          }),
        });

        const data = await resp.json().catch(() => null);
        if (!resp.ok || !data?.ok) {
          if (isProfileRequiredError(data)) {
            onOpenChange(false);
            setProfileRequiredOpen(true);
            return;
          }
          throw new Error(data?.error || "Failed to create itinerary");
        }

        toast.success(
          buildMode === "pagoda_build"
            ? "Request submitted! The Pagoda team will build your proposal and email you when it's ready."
            : "Draft itinerary created!"
        );

        // Reset form and close modal
        setFormData({
          itineraryName: "",
          country: "Japan",
          startDate: "",
          endDate: "",
        });
        setBuildMode("pagoda_build");
        setIntake(emptyIntakeData());
        onOpenChange(false);

        // Call the callback with the new itinerary
        if (onItineraryCreated && data.itinerary) {
          const newItinerary: CardItinerary = {
            id: String(data.itinerary.id),
            title: String(data.itinerary.name),
            location: String(data.itinerary.location),
            startDate: String(data.itinerary.start_date),
            endDate: String(data.itinerary.end_date),
            duration: calculateDuration(
              String(data.itinerary.start_date),
              String(data.itinerary.end_date)
            ),
            jobsCount: 0,
            unassignedCount: 0,
            activities: [],
            status: "draft",
          };
          onItineraryCreated(newItinerary);
        } else {
          // Refresh the page to show the new itinerary if no callback provided
          window.location.reload();
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Something went wrong";
      if (isProfileRequiredError({ error: msg })) {
        onOpenChange(false);
        setProfileRequiredOpen(true);
      } else {
        toast.error(msg);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleSenseiGenerate = async () => {
    if (isEditMode) return;

    // Read from ref so a rapid type-then-click can't pick up a stale closure value.
    const currentIntake = intakeRef.current;

    // Same form-field validation as handleSubmit
    if (!formData.itineraryName || !formData.country || !formData.startDate || !formData.endDate) {
      toast.error("Please fill all required fields.");
      return;
    }
    const startDate = parseSafariDate(formData.startDate);
    const endDate = parseSafariDate(formData.endDate);
    if (!startDate || !endDate) {
      toast.error("Please enter valid dates.");
      return;
    }
    if (endDate < startDate) {
      toast.error("Departure date cannot be before Arrival date.");
      return;
    }

    // Sensei requires the same fields as pagoda_build
    const intakeErr = validateIntakeForPagodaBuild(currentIntake);
    if (intakeErr) {
      toast.error(intakeErr);
      return;
    }

    // Catch rows added via "+ Add city" whose city name was never filled in.
    // intakeDataForApi silently strips empty-city rows, so without this check the
    // third city would vanish from the request with no feedback to the user.
    const hasBlankCity = (currentIntake.destinationStays ?? []).some(
      (s) => !s.city?.trim()
    );
    if (hasBlankCity) {
      toast.error("Please fill in or remove the empty destination row before continuing.");
      return;
    }

    setSubmitting(true);
    setSenseiStatusMsg("Generating with Sensei…");
    try {
      // Resolve user_id + profile_id server-side (cookies are not accessible client-side)
      const meRes = await fetch("/api/me/profile-id", { cache: "no-store" });
      const meData = await meRes.json().catch(() => null);
      if (!meRes.ok || !meData?.ok) {
        if (meData?.code === "PROFILE_REQUIRED" || isProfileRequiredError(meData)) {
          onOpenChange(false);
          setProfileRequiredOpen(true);
          return;
        }
        throw new Error(meData?.error || "Could not load your profile.");
      }

      const cleaned = intakeDataForApi(currentIntake);
      const requestBody = {
        user_id: String(meData.userId),
        profile_id: String(meData.profileId),
        name: formData.itineraryName,
        arrival_date: formData.startDate,
        departure_date: formData.endDate,
        ...cleaned,
      };

      // Step 1: POST to async endpoint — returns { job_id } immediately (202)
      const asyncRes = await fetch("https://pagoda-ai.vercel.app/create-itinerary-async", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const asyncData = await asyncRes.json().catch(() => null);
      if (!asyncRes.ok || !asyncData?.job_id) {
        const errMsg =
          typeof asyncData?.detail === "string"
            ? asyncData.detail
            : Array.isArray(asyncData?.detail)
            ? (asyncData.detail[0]?.msg ?? "Sensei failed to start.")
            : (asyncData?.error ?? "Sensei failed to start.");
        throw new Error(errMsg);
      }
      const jobId: string = asyncData.job_id;

      // Step 2: Fire the process endpoint and confirm it doesn't immediately reject.
      // Don't await the body — the processing runs asynchronously on the server.
      const processRes = await fetch(
        `https://pagoda-ai.vercel.app/create-itinerary-process/${jobId}`,
        { method: "POST" }
      );
      if (!processRes.ok) {
        const processData = await processRes.json().catch(() => null);
        const errMsg =
          typeof processData?.detail === "string"
            ? processData.detail
            : (processData?.error ?? "Sensei failed to start processing.");
        throw new Error(errMsg);
      }

      // Step 3: Poll GET /create-itinerary-status/{job_id} every 3 s, up to 4 minutes.
      const POLL_INTERVAL_MS = 3_000;
      const TIMEOUT_MS = 4 * 60 * 1_000;
      const ROTATE_EVERY_MS = 15_000;
      const rotatingMessages = [
        "Still working — longer itineraries take a bit more time…",
        "Almost there — Sensei is matching tours for each day…",
        "Hang tight — finalising your itinerary now…",
      ];
      let rotatingIdx = 0;
      const pollStart = Date.now();
      let lastRotateAt = pollStart;

      while (true) {
        await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

        const elapsed = Date.now() - pollStart;

        // Overall timeout — leave modal open; Sensei may still finish in the background.
        if (elapsed >= TIMEOUT_MS) {
          toast(
            "This is taking longer than expected. You can close this and check back on your itineraries list shortly — Sensei may still finish in the background.",
            { duration: 10_000 }
          );
          return;
        }

        // Rotate button label every ~15 s so it doesn't look frozen.
        if (Date.now() - lastRotateAt >= ROTATE_EVERY_MS) {
          setSenseiStatusMsg(rotatingMessages[rotatingIdx % rotatingMessages.length]);
          rotatingIdx++;
          lastRotateAt = Date.now();
        }

        const statusRes = await fetch(
          `https://pagoda-ai.vercel.app/create-itinerary-status/${jobId}`,
          { cache: "no-store" }
        );
        if (!statusRes.ok) {
          // Transient network hiccup — keep polling.
          continue;
        }
        const result = await statusRes.json().catch(() => null);
        const status: string = result?.status ?? "";

        if (status === "done") {
          const jobsCreated: number = result.jobs_created ?? 0;
          toast.success(
            `Itinerary generated! ${jobsCreated} tour${jobsCreated === 1 ? "" : "s"} matched.`
          );

          setFormData({ itineraryName: "", country: "Japan", startDate: "", endDate: "" });
          setBuildMode("pagoda_build");
          setIntake(emptyIntakeData());
          onOpenChange(false);

          if (onItineraryCreated) {
            const newItinerary: CardItinerary = {
              id: String(result.itinerary_id),
              title: formData.itineraryName,
              location: formData.country,
              startDate: formData.startDate,
              endDate: formData.endDate,
              duration: calculateDuration(formData.startDate, formData.endDate),
              jobsCount: jobsCreated,
              unassignedCount: jobsCreated,
              activities: [],
              status: "draft",
            };
            onItineraryCreated(newItinerary);
          }

          router.push(`/agent/edit-itinerary?itineraryId=${result.itinerary_id}`);
          return;
        }

        if (status === "failed") {
          const errMsg =
            typeof result?.error === "string"
              ? result.error
              : "Sensei failed to generate the itinerary.";
          toast.error(errMsg);
          // Keep modal open so the advisor can retry.
          return;
        }

        // status === "processing" — continue polling.
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Something went wrong with Sensei.";
      toast.error(msg);
      // Do NOT close the modal on failure — let the advisor retry.
    } finally {
      setSubmitting(false);
      setSenseiStatusMsg("");
    }
  };

  // Reset form when modal closes
  const handleOpenChange = (open: boolean) => {
    if (!open) {
      // Reset form when closing
      setFormData({
        itineraryName: "",
        country: "Japan",
        startDate: "",
        endDate: "",
      });
    }
    onOpenChange(open);
  };

  return (
    <>
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-2xl w-full px-6 sm:px-8 lg:px-10 rounded-2xl max-h-[90vh] overflow-y-auto p-6 scrollbar-none [-ms-overflow-style:none] [&::-webkit-scrollbar:hidden]"
      >
        {/* Close Button */}
        <button
          onClick={() => handleOpenChange(false)}
          className="absolute right-4 top-4 p-2 hover:bg-gray-100 rounded-lg transition-colors z-10"
        >
          <X className="w-5 h-5" />
        </button>

        <DialogHeader className="flex flex-col items-center justify-center text-center pt-2">
          <h1 className="text-3xl font-bold">
            {isEditMode ? "Edit Itinerary" : "Create Draft Itinerary"}
          </h1>
          <p className="text-sm text-muted-foreground -mt-2">
            {isEditMode
              ? "Update your trip itinerary details"
              : "Tell us about your client's trip — then build yourself or ask Pagoda to create the proposal"}
          </p>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6 py-4">
          {/* Itinerary Name */}
          <div className="space-y-3">
            <label className="text-sm font-medium text-foreground">
              Itinerary Name
            </label>
            <div className="mt-3">
              <Input
                name="itineraryName"
                placeholder="e.g. Japanese Cultural Adventure"
                value={formData.itineraryName}
                onChange={handleInputChange}
                required
                className="border-input"
              />
            </div>
          </div>

          <CountrySelect
            label="Country"
            value={formData.country}
            onChange={(country) =>
              setFormData((prev) => ({ ...prev, country }))
            }
            required
          />

          {/* Dates */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-3">
              <label className="text-sm font-medium text-foreground flex items-center gap-2">
                <Calendar className="w-4 h-4 shrink-0" /> Arrival date
              </label>
              <Input
                name="startDate"
                type="date"
                value={formData.startDate}
                onChange={handleInputChange}
                required
                className="border-input"
              />
            </div>
            <div className="space-y-3">
              <label className="text-sm font-medium text-foreground flex items-center gap-2">
                <Calendar className="w-4 h-4 shrink-0" /> Departure Date
              </label>
              <Input
                name="endDate"
                type="date"
                value={formData.endDate}
                onChange={handleInputChange}
                required
                className="border-input"
              />
            </div>
          </div>

          <ItineraryIntakeFields
            buildMode={buildMode}
            onBuildModeChange={setBuildMode}
            intake={intake}
            onIntakeChange={(patch) => {
              setIntake((prev) => ({ ...prev, ...patch }));
              if (patch.primaryDestination) {
                setFormData((prev) => ({
                  ...prev,
                  country: patch.primaryDestination || prev.country,
                }));
              }
            }}
            arrivalDate={formData.startDate}
            departureDate={formData.endDate}
            onDatesChange={(patch) =>
              setFormData((prev) => ({
                ...prev,
                startDate: patch.arrivalDate ?? prev.startDate,
                endDate: patch.departureDate ?? prev.endDate,
              }))
            }
            disabled={submitting}
            onSenseiGenerate={!isEditMode ? handleSenseiGenerate : undefined}
            senseiStatusLabel={senseiStatusMsg || undefined}
          />

          {/* Submit Button */}
          <Button
            type="submit"
            disabled={submitting}
            className="w-full bg-[#D4AA25] hover:bg-[#C49A1F] text-white font-semibold"
          >
            {submitting
              ? isEditMode
                ? "Updating…"
                : "Creating Draft…"
              : isEditMode
              ? "Update Itinerary"
              : "Create Draft"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>

    <AlertDialog open={profileRequiredOpen} onOpenChange={setProfileRequiredOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Complete your profile</AlertDialogTitle>
          <AlertDialogDescription>
            Before you can create an itinerary, please complete your profile.
            This only takes a minute and is required for bookings and account setup.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Not now</AlertDialogCancel>
          <AlertDialogAction
            className="bg-[#D4AA25] hover:bg-[#C49A1F] text-white"
            onClick={() => {
              setProfileRequiredOpen(false);
              router.push(settingsHrefForPath(pathname));
            }}
          >
            Go to profile
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}
