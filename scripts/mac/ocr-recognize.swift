#!/usr/bin/env swift
// macOS OCR via Vision framework (VNRecognizeTextRequest)
// Takes an image path, outputs JSON result to stdout.
// Matches the same JSON format as ocr-recognize.ps1 (Windows).
//
// Usage: swift ocr-recognize.swift /path/to/image.png

import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count > 1 else {
    let err: [String: Any] = ["error": "Usage: ocr-recognize.swift <image-path>"]
    if let data = try? JSONSerialization.data(withJSONObject: err),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    }
    exit(0)
}

let imagePath = CommandLine.arguments[1]
let imageURL = URL(fileURLWithPath: imagePath)

guard let image = NSImage(contentsOf: imageURL),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    let err: [String: Any] = ["error": "Failed to load image: \(imagePath)"]
    if let data = try? JSONSerialization.data(withJSONObject: err),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    }
    exit(0)
}

let imageWidth = CGFloat(cgImage.width)
let imageHeight = CGFloat(cgImage.height)

let semaphore = DispatchSemaphore(value: 0)
var elements: [[String: Any]] = []
var fullText = ""

let request = VNRecognizeTextRequest { request, error in
    defer { semaphore.signal() }

    if let error = error {
        let err: [String: Any] = ["error": "OCR failed: \(error.localizedDescription)"]
        if let data = try? JSONSerialization.data(withJSONObject: err),
           let str = String(data: data, encoding: .utf8) {
            print(str)
        }
        return
    }

    guard let observations = request.results as? [VNRecognizedTextObservation] else { return }

    var lineIdx = 0
    var lines: [String] = []

    for observation in observations {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let text = candidate.string
        let confidence = candidate.confidence
        let box = observation.boundingBox

        // Vision coordinates: origin bottom-left, normalized 0-1
        // Convert to screen pixels: origin top-left
        let x = box.origin.x * imageWidth
        let y = (1.0 - box.origin.y - box.height) * imageHeight
        let w = box.width * imageWidth
        let h = box.height * imageHeight

        // Split into words for per-word bounding boxes (approximate)
        let words = text.components(separatedBy: " ")
        let wordWidth = w / CGFloat(max(words.count, 1))

        for (i, word) in words.enumerated() {
            guard !word.isEmpty else { continue }
            let element: [String: Any] = [
                "text": word,
                "x": Int(round(x + wordWidth * CGFloat(i))),
                "y": Int(round(y)),
                "width": Int(round(wordWidth)),
                "height": Int(round(h)),
                "confidence": round(Double(confidence) * 100) / 100,
                "line": lineIdx
            ]
            elements.append(element)
        }

        lines.append(text)
        lineIdx += 1
    }

    fullText = lines.joined(separator: "\n")
}

// Configure for accuracy (fast is also available)
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    let err: [String: Any] = ["error": "VNImageRequestHandler failed: \(error.localizedDescription)"]
    if let data = try? JSONSerialization.data(withJSONObject: err),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    }
    exit(0)
}

// Wait for async completion
semaphore.wait()

// Output JSON matching Windows format
let result: [String: Any] = [
    "elements": elements,
    "fullText": fullText
]

if let data = try? JSONSerialization.data(withJSONObject: result),
   let str = String(data: data, encoding: .utf8) {
    print(str)
}
