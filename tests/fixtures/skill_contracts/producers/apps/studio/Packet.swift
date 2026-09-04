let packetURL = projectURL
    .appendingPathComponent("09_output")
    .appendingPathComponent("editor_packet")
let manifestURL = packetURL.appendingPathComponent("manifest.json")
try data.write(to: manifestURL)
