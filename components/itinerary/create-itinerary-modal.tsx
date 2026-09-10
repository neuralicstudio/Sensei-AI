"use client";

import type React from "react";

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader } from "@/components/ui/dialog";
import { Calendar, MapPin, X, Upload, Search, ChevronDown } from "lucide-react";
import toast from "react-hot-toast";
import { uploadViaApi } from "@/lib/upload-client";
import { BUCKETS } from "@/lib/buckets";
import { signItineraryHeroPath } from "@/lib/job-tour-image-sign";
import Image from "next/image";
import countries from "world-countries";
import { CardItinerary } from "@/app/types";

interface CreateItineraryModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onItineraryCreated?: (itinerary: CardItinerary) => void;
  itinerary?: CardItinerary | null; // For edit mode
}

// Format countries for the dropdown - using common name and sorting alphabetically
const formattedCountries = countries
  .map((country) => ({
    name: country.name.common,
    flag: country.flag,
    cca2: country.cca2,
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

// Helper function to calculate duration
const calculateDuration = (startDate: string, endDate: string) => {
  const start = new Date(startDate);
  const end = new Date(endDate);
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
  const [formData, setFormData] = useState({
    itineraryName: "",
    country: "",
    startDate: "",
    endDate: "",
  });
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [existingImagePath, setExistingImagePath] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [countryOpen, setCountryOpen] = useState(false);
  const [countrySearch, setCountrySearch] = useState("");
  const countryDropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        countryDropdownRef.current &&
        !countryDropdownRef.current.contains(event.target as Node)
      ) {
        setCountryOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

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

            // Load existing image if available
            const imagePath = it.image || itinerary.image;
            if (imagePath) {
              setExistingImagePath(imagePath);
              void signItineraryHeroPath(imagePath).then((url) => {
                if (url) setImagePreview(url);
              });
            }
          } else {
            // Fallback to basic itinerary data if API fails
            setFormData({
              itineraryName: itinerary.title || "",
              country: itinerary.location || "",
              startDate: itinerary.startDate || "",
              endDate: itinerary.endDate || "",
            });

            if (itinerary.image) {
              setExistingImagePath(itinerary.image);
              void signItineraryHeroPath(itinerary.image).then((url) => {
                if (url) setImagePreview(url);
              });
            }
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
        country: "",
        startDate: "",
        endDate: "",
      });
      setImageFile(null);
      setImagePreview(null);
      setExistingImagePath(null);
    }
  }, [isEditMode, itinerary, open]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleCountrySelect = (countryName: string) => {
    setFormData((prev) => ({
      ...prev,
      country: countryName,
    }));
    setCountryOpen(false);
    setCountrySearch("");
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

    if (new Date(formData.endDate) < new Date(formData.startDate)) {
      toast.error("Departure date cannot be before Arrival date.");
      return;
    }

    setSubmitting(true);
    try {
      // 1) Upload image if a new one was selected
      let imagePath: string | null = null;
      if (imageFile) {
        const [res] = await uploadViaApi(imageFile, {
          bucket: BUCKETS.itineraries,
          folder: "images",
        });
        imagePath = res?.path ?? null;
      } else if (isEditMode && existingImagePath) {
        // Keep existing image if no new one was uploaded
        imagePath = existingImagePath;
      }

      if (isEditMode && itinerary) {
        // Update existing itinerary
        const resp = await fetch(`/api/itineraries/${itinerary.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: formData.itineraryName,
            location: formData.country,
            start_date: formData.startDate,
            end_date: formData.endDate,
            image: imagePath,
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
          country: "",
          startDate: "",
          endDate: "",
        });
        setImageFile(null);
        setImagePreview(null);
        setExistingImagePath(null);
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
            image: imagePath || undefined,
          };
          onItineraryCreated(updatedItinerary);
        } else {
          // Refresh the page to show the updated itinerary if no callback provided
          window.location.reload();
        }
      } else {
        // Create new itinerary
        const status = "draft";

        const resp = await fetch("/api/itinerary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: formData.itineraryName,
            location: formData.country,
            startDate: formData.startDate,
            endDate: formData.endDate,
            imagePath,
            status: status,
          }),
        });

        const data = await resp.json().catch(() => null);
        if (!resp.ok || !data?.ok || !data?.id) {
          throw new Error(data?.error || "Failed to create itinerary");
        }

        toast.success("Draft itinerary created!");

        // Reset form and close modal
        setFormData({
          itineraryName: "",
          country: "",
          startDate: "",
          endDate: "",
        });
        setImageFile(null);
        setImagePreview(null);
        setExistingImagePath(null);
        onOpenChange(false);

        // Call the callback with the new itinerary (constructed from form data)
        if (onItineraryCreated && data.id) {
          const newItinerary: CardItinerary = {
            id: String(data.id),
            title: formData.itineraryName,
            location: formData.country,
            startDate: formData.startDate,
            endDate: formData.endDate,
            duration: calculateDuration(formData.startDate, formData.endDate),
            jobsCount: 0,
            unassignedCount: 0,
            activities: [],
            status: "draft",
            image: imagePath || undefined,
          };
          onItineraryCreated(newItinerary);
        } else {
          // Refresh the page to show the new itinerary if no callback provided
          window.location.reload();
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Something went wrong";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;

    if (file) {
      // Validate file type
      if (!file.type.startsWith("image/")) {
        toast.error("Please select an image file");
        return;
      }

      // Validate file size (10MB)
      if (file.size > 1 * 1024 * 1024) {
        toast.error("Image size should be less than 1MB");
        return;
      }

      setImageFile(file);

      // Create preview
      const reader = new FileReader();
      reader.onload = (e) => {
        setImagePreview(e.target?.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleRemoveImage = () => {
    setImageFile(null);
    setImagePreview(null);
    setExistingImagePath(null);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();

    const files = e.dataTransfer.files;
    if (files && files[0]) {
      const file = files[0];

      if (!file.type.startsWith("image/")) {
        toast.error("Please drop an image file");
        return;
      }

      if (file.size > 1 * 1024 * 1024) {
        toast.error("Image size should be less than 1MB");
        return;
      }

      setImageFile(file);

      // Create preview
      const reader = new FileReader();
      reader.onload = (e) => {
        setImagePreview(e.target?.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  // Filter countries based on search
  const filteredCountries = formattedCountries.filter((country) =>
    country.name.toLowerCase().includes(countrySearch.toLowerCase())
  );

  // Reset form when modal closes
  const handleOpenChange = (open: boolean) => {
    if (!open) {
      // Reset form when closing
      setFormData({
        itineraryName: "",
        country: "",
        startDate: "",
        endDate: "",
      });
      setImageFile(null);
      setImagePreview(null);
      setExistingImagePath(null);
      setCountrySearch("");
      setCountryOpen(false);
    }
    onOpenChange(open);
  };

  // Find selected country for display
  const selectedCountry = formattedCountries.find(
    (country) => country.name === formData.country
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg w-full px-6 sm:px-8 lg:px-14 rounded-2xl max-h-[90vh] overflow-y-auto">
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
              : "Start building a new trip itinerary"}
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

          {/* Country - Custom Searchable Select */}
          <div className="space-y-3">
            <label className="text-sm font-medium text-foreground flex items-center gap-2">
              <MapPin className="w-4 h-4 flex-shrink-0" /> Country
            </label>
            <div className="relative" ref={countryDropdownRef}>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCountryOpen(!countryOpen)}
                className="w-full justify-between border-input h-10"
              >
                {selectedCountry ? (
                  <div className="flex items-center gap-2">
                    <span className="text-base">{selectedCountry.flag}</span>
                    <span>{selectedCountry.name}</span>
                  </div>
                ) : (
                  "Select a country..."
                )}
                <ChevronDown
                  className={`ml-2 h-4 w-4 transition-transform ${
                    countryOpen ? "rotate-180" : ""
                  }`}
                />
              </Button>

              {countryOpen && (
                <div className="absolute z-50 w-full mt-1 bg-background border border-border rounded-md shadow-lg">
                  {/* Search Input */}
                  <div className="p-2 border-b border-border">
                    <div className="relative">
                      <Search className="absolute left-2 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        placeholder="Search countries..."
                        value={countrySearch}
                        onChange={(e) => setCountrySearch(e.target.value)}
                        className="pl-8 border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                        autoFocus
                      />
                    </div>
                  </div>

                  {/* Country List */}
                  <div className="max-h-60 overflow-y-auto">
                    {filteredCountries.length === 0 ? (
                      <div className="p-4 text-center text-muted-foreground text-sm">
                        No countries found
                      </div>
                    ) : (
                      filteredCountries.map((country) => (
                        <button
                          key={country.cca2}
                          type="button"
                          onClick={() => handleCountrySelect(country.name)}
                          className={`w-full text-left px-4 py-2 hover:bg-muted transition-colors flex items-center gap-2 ${
                            formData.country === country.name ? "bg-muted" : ""
                          }`}
                        >
                          <span className="text-base">{country.flag}</span>
                          <span>{country.name}</span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-3">
              <label className="text-sm font-medium text-foreground flex items-center gap-2">
                <Calendar className="w-4 h-4 flex-shrink-0" /> Arrival Date
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
                <Calendar className="w-4 h-4 flex-shrink-0" /> Departure Date
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

          {/* Upload Image */}
          <div className="space-y-3 border-t border-border pt-4">
            <label className="text-sm font-medium text-foreground">
              Upload Image
            </label>

            {imagePreview ? (
              // Image Preview
              <div className="relative border-2 border-border rounded-lg overflow-hidden group">
                <div className="aspect-video relative">
                  <Image
                    src={imagePreview}
                    alt="Itinerary preview"
                    fill
                    className="object-cover"
                  />
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-all duration-200" />
                </div>
                <button
                  type="button"
                  onClick={handleRemoveImage}
                  className="absolute top-2 right-2 p-1.5 bg-red-500 hover:bg-red-600 text-white rounded-full transition-colors"
                  aria-label="Remove image"
                >
                  <X className="w-4 h-4" />
                </button>
                <div className="absolute bottom-2 left-2">
                  <span className="text-xs text-white bg-black/50 px-2 py-1 rounded">
                    {imageFile?.name}
                  </span>
                </div>
              </div>
            ) : (
              // Upload Area
              <div
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                className="border-2 border-dashed border-border rounded-lg p-8 text-center hover:border-[#D4AA25] transition-colors cursor-pointer group"
              >
                <input
                  id="itinerary-image"
                  type="file"
                  accept="image/*"
                  onChange={handleImageChange}
                  className="hidden"
                />
                <label
                  htmlFor="itinerary-image"
                  className="cursor-pointer block"
                >
                  <div className="flex flex-col items-center justify-center gap-3">
                    <div className="p-3 bg-muted rounded-full group-hover:bg-[#D4AA25]/10 transition-colors">
                      <Upload className="w-6 h-6 text-muted-foreground group-hover:text-[#D4AA25] transition-colors" />
                    </div>
                    <div>
                      <div className="text-sm text-muted-foreground group-hover:text-foreground transition-colors">
                        Click to upload an image or drag and drop the image you
                        want to use for this tour
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        PNG, JPG up to 1MB
                      </div>
                    </div>
                  </div>
                </label>
              </div>
            )}
          </div>

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
  );
}
